// L-ITEM item 4: the link checker's items mode (apps/linkcheck/src/items.ts) writes and reads its four
// LinkCheckService messages by hand; here they are held to the API's generated ones, byte for byte.
// MACHINE-ROUTE: the checker now calls the site's Connect route, which forwards to this API over the mesh,
// so its runs against the real API server live in apps/web test/machine-route-live.test.ts (the site in
// front of this API's real routes and caller gate). Every address here is made up.
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { MACHINE, decodeListResponse, decodeRecordResponse, encodeRecordRequest } from '../../../linkcheck/src/items.js';
import { MachineVerdict } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { ListLinksAwaitingVerdictResponseSchema, RecordLinkVerdictsRequestSchema, RecordLinkVerdictsResponseSchema } from '../../src/gen/nwfl/mensa/v1/link_check_pb.js';

describe("the items mode's messages are the API's", () => {
  it('names the verdicts as the API numbers them', () => {
    expect(MACHINE).toEqual({ OK: MachineVerdict.OK, CONFIRM: MachineVerdict.CONFIRM, DROP: MachineVerdict.DROP });
  });

  it('writes RecordLinkVerdictsRequest as the generated code does', () => {
    const verdicts = [
      { url: 'https://a.example.org/', verdict: MACHINE.OK, reasons: [] },
      { url: `https://b.example.org/${'x'.repeat(300)}`, verdict: MACHINE.DROP, reasons: ['dead', 'nxdomain'] },
      { url: 'mailto:c@example.org', verdict: MACHINE.CONFIRM, reasons: ['no-mail'] },
    ];
    const ours = encodeRecordRequest(verdicts);
    expect(ours).toEqual(toBinary(RecordLinkVerdictsRequestSchema, create(RecordLinkVerdictsRequestSchema, { verdicts })));
    expect(fromBinary(RecordLinkVerdictsRequestSchema, ours).verdicts.map((v) => [v.url, v.verdict, v.reasons])).toEqual(verdicts.map((v) => [v.url, v.verdict, v.reasons]));
  });

  it('reads the answers the generated code writes', () => {
    const urls = ['https://a.example.org/', `https://b.example.org/${'é'.repeat(500)}`];
    expect(decodeListResponse(toBinary(ListLinksAwaitingVerdictResponseSchema, create(ListLinksAwaitingVerdictResponseSchema, { urls, more: true })))).toEqual({ urls, more: true });
    expect(decodeRecordResponse(toBinary(RecordLinkVerdictsResponseSchema, create(RecordLinkVerdictsResponseSchema, { recorded: 70000, notAwaiting: urls })))).toEqual({
      recorded: 70000,
      notAwaiting: urls,
    });
  });
});
