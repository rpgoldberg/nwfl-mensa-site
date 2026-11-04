// The officer area's client for nwfl-mensa-api (SOLO-APPROVE): ApprovalRuleService only, kept apart
// from the public reads in client.ts. The same wire as client.ts (gRPC over HTTP/2, never Connect or
// gRPC-Web; the API's address and timeout from API_URL and API_TIMEOUT_MS), but every call carries
// the signed-in officer's access token as "Authorization: Bearer", and only these RPCs take one.
// The API decides who may read and who may set the rule (the Admin alone); the site only hides the
// switch from everyone else.
//
// A refused token (UNAUTHENTICATED), or a bearer that is not one b64token, is OfficerSignInAgain:
// the page asks the officer to sign in again. Any other failure is logged by call and code (never
// the API's message, the token or the reason) and becomes ApiUnavailable, as for the public reads.
import { PUBLIC_ONLY } from 'astro:env/server';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { Session } from '../../../server/session.mjs';
import type { TokenStore } from '../../../server/token-store.mjs';
import { ApprovalRule, ApprovalRuleService, ApprovalScope, type ApprovalSetting } from '../../gen/nwfl/mensa/v1/approval_pb.js';
import type { Rule, Scope, Setting } from '../approval-rules';
import { EXPIRY_MARGIN_SECONDS } from '../auth/bearer';
import type { Tokens } from '../auth/oidc';
import { type ApiConfig, ApiUnavailable, READ_MAX_BYTES, type Reader, apiSetup, sendable } from './client';

/** The officer's token was refused, has run out, or is not one to send: sign in again. */
export class OfficerSignInAgain extends Error {
  constructor(readonly rpc: string) {
    super(`sign in again for ${rpc}`);
    this.name = 'OfficerSignInAgain';
  }
}

export interface OfficerApi {
  getApprovalRules(as: Reader): Promise<Setting[]>;
  setApprovalRule(as: Reader, change: { scope: Scope; rule: Rule; reason: string }): Promise<{ changed: boolean }>;
}

const SCOPE_IN: Record<Scope, ApprovalScope> = { content: ApprovalScope.CONTENT, redaction_policy: ApprovalScope.REDACTION_POLICY };
const RULE_IN: Record<Rule, ApprovalRule> = { two_person: ApprovalRule.TWO_PERSON, one_approver: ApprovalRule.ONE_APPROVER };

function nameOf<K extends string, V>(table: Record<K, V>, value: V): K | undefined {
  return (Object.keys(table) as K[]).find((key) => table[key] === value);
}

const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/** A setting as the pages use it; an unset or unknown scope or rule is an answer the site cannot read. */
function settingOf(setting: ApprovalSetting): Setting {
  const scope = nameOf(SCOPE_IN, setting.scope);
  const rule = nameOf(RULE_IN, setting.rule);
  if (scope === undefined || rule === undefined) throw new ConnectError('an approval setting the site cannot read', Code.DataLoss);
  return { scope, rule, ...(setting.setAt ? { setAt: timestampDate(setting.setAt) } : {}) };
}

export function grpcOfficer(config: ApiConfig, log: (line: string) => void): OfficerApi {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES });
  const rules = createClient(ApprovalRuleService, transport);

  const call = async <T>(rpc: string, as: Reader, run: (headers: { authorization: string }) => Promise<T>): Promise<T> => {
    const reader = sendable(as);
    if (reader === undefined) throw new OfficerSignInAgain(rpc);
    try {
      return await run({ authorization: `Bearer ${reader.bearer}` });
    } catch (error) {
      const code = ConnectError.from(error).code;
      if (code === Code.Unauthenticated) {
        log(JSON.stringify({ level: 'warn', msg: 'api refused the token', rpc, code: codeName(code) }));
        throw new OfficerSignInAgain(rpc);
      }
      log(JSON.stringify({ level: 'error', msg: 'api call failed', rpc, code: codeName(code) }));
      throw new ApiUnavailable(rpc);
    }
  };

  return {
    getApprovalRules: (as) => call('GetApprovalRules', as, async (headers) => (await rules.getApprovalRules({}, { headers })).settings.map(settingOf)),
    setApprovalRule: (as, change) =>
      call('SetApprovalRule', as, async (headers) => {
        const answer = await rules.setApprovalRule({ scope: SCOPE_IN[change.scope], rule: RULE_IN[change.rule], reason: change.reason }, { headers });
        if (answer.setting === undefined) throw new ConnectError('no setting in the answer', Code.DataLoss);
        settingOf(answer.setting);
        return { changed: answer.changed };
      }),
  };
}

/** Every call fails: the API is switched on but set up wrongly. */
export function unavailableOfficer(): OfficerApi {
  return {
    getApprovalRules: () => Promise.reject(new ApiUnavailable('GetApprovalRules')),
    setApprovalRule: () => Promise.reject(new ApiUnavailable('SetApprovalRule')),
  };
}

/** The officer client for this environment: none without API_URL, and none in a public-only build (no sign-in at all). */
export function officerFromEnv(env: Record<string, string | undefined>, { publicOnly, log }: { publicOnly: boolean; log: (line: string) => void }): OfficerApi | undefined {
  if (publicOnly) return undefined;
  const setup = apiSetup(env);
  if (!setup.enabled) return undefined;
  if ('error' in setup) {
    log(JSON.stringify({ level: 'error', msg: setup.error }));
    return unavailableOfficer();
  }
  return grpcOfficer(setup.config, log);
}

let officer: { api: OfficerApi | undefined } | undefined;

/** One per process, as liveData() is. */
export function officerApi(): OfficerApi | undefined {
  officer ??= { api: officerFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: (line) => console.error(line) }) };
  return officer.api;
}

export interface OfficerReaderDeps {
  tokens: Pick<TokenStore<Tokens>, 'get'>;
  /** Seconds. */
  now: () => number;
}

/**
 * The officer's access token to send, if any: for an officer's live session whose token has more than
 * 30 seconds to live. Lapsed when an officer's session or token has run out (sign in again).
 */
export function officerReader(session: Session | undefined, { tokens, now }: OfficerReaderDeps): { reader: Reader | undefined; lapsed: boolean } {
  if (session?.officer !== true) return { reader: undefined, lapsed: false };
  const at = now();
  if (session.exp <= at) return { reader: undefined, lapsed: true };
  const record = tokens.get(session.sid, at);
  const expiresAt = record?.expires_at;
  if (record === undefined || record.access_token === '' || typeof expiresAt !== 'number' || expiresAt - EXPIRY_MARGIN_SECONDS <= at) return { reader: undefined, lapsed: true };
  return { reader: { bearer: record.access_token }, lapsed: false };
}
