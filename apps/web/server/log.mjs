// @ts-check
// LG-N3: the site's one log line shape. Every line is one JSON object with the fields the caller
// gives, then `time` (ISO), `service` and, while a request is served, its `trace_id` (trace.mjs).
// Those three are set last, so no field can stand in for them.
import { currentTrace } from './trace.mjs';

export const SERVICE = 'nwfl-web';

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function logEntry(fields) {
  const trace = currentTrace();
  // With no trace, trace_id is undefined and JSON leaves it out: a field of that name never stands in.
  return JSON.stringify({ ...fields, time: new Date().toISOString(), service: SERVICE, trace_id: trace?.traceId });
}

/**
 * A log callback that stamps each line before `write` gets it. A line that is a JSON object keeps
 * its fields; any other text becomes the line's msg.
 *
 * @param {(line: string) => void} write
 * @returns {(line: string) => void}
 */
export function stamped(write) {
  return (line) => {
    /** @type {unknown} */
    let fields;
    try {
      fields = JSON.parse(line);
    } catch {
      fields = undefined;
    }
    write(logEntry(fields !== null && typeof fields === 'object' && !Array.isArray(fields) ? /** @type {Record<string, unknown>} */ (fields) : { msg: line }));
  };
}

/** The API clients' log callback in production: stamped lines on stderr. */
export const apiLog = stamped((line) => console.error(line));
