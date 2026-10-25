/**
 * Node half of the test command bridge.
 *
 * The browser half lives in `./client.js` and is picked up by `dsh.client`;
 * this half exists so the Loader row names a package root and the client
 * module scanner can find the manifest.
 */
export const name = 'command-bridge';
export const inject = [];
export function apply() {}
