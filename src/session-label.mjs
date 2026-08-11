// How a session is named on screen, and what it can do — in one place because
// three views ask the same question (the tab strip, the connect form's live
// session list, and the file explorer's pane heading) and they must not answer
// it differently.
//
// A local shell has no host, no user and no port: the service fills those
// fields with placeholders so nothing downstream has to branch (see
// service/lib/local-session.js), which is exactly why the LABEL has to branch
// — rendering the placeholders would put "root@localhost:0" on a tab.

export function isLocalSession(session) {
  return Boolean(session) && session.kind === "local";
}

// The tab strip's dialect: short, one per tab, `1:host*`. This returns just
// the host part; the index and the active marker belong to the strip.
export function sessionShortLabel(session) {
  if (isLocalSession(session)) return "local";
  return (session && session.host) || "?";
}

// The tooltip / list line: the full identity.
export function sessionTitle(session) {
  if (isLocalSession(session)) return "Local shell on this TV (root)";
  const user = (session && session.user) || "?";
  const host = (session && session.host) || "?";
  const port = (session && session.port) || 22;
  return `${user}@${host}:${port}`;
}

// File transfer is an SFTP channel on an SSH transport. A local session's
// transport is a unix socket to ptyd that speaks five terminal frames and
// nothing else, so the files tab must not be offered for one — the service
// refuses it (sftp.js: NO_SFTP), and an offer that always fails is worse than
// no offer.
export function canBrowseFiles(session) {
  return !isLocalSession(session);
}
