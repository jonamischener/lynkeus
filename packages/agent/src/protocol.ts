// Types only: lynkeus-protocol must not become a runtime dependency of the app,
// so the version is declared here too (the protocol's shape test keeps them equal).
export type * from 'lynkeus-protocol';

export const PROTOCOL_VERSION = 1;
