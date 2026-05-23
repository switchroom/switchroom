#!/usr/bin/env node
// Phase 0 spike agent client. Connects to its own broker socket
// and exercises:
//   1. allow path        — request a key in its ACL
//   2. deny path         — request a key in another agent's ACL
//   3. cross-mount probe — attempt to connect to OTHER_SOCK. In a
//                          standard alice/bob container the other
//                          agent's socket dir is NOT mounted, so the
//                          attempt resolves at ENOENT — that's a
//                          *compose discipline* boundary, not a
//                          file-perm boundary, and is reported as
//                          such. The hostile container (run via the
//                          compose `hostile` profile) cross-mounts
//                          BOTH socket dirs and exercises the actual
//                          file-perm boundary; in that case ENOENT
//                          would be a FAIL and we expect EACCES.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const SELF = process.env.AGENT_NAME || "alice";
const OTHER = process.env.OTHER_AGENT || (SELF === "alice" ? "bob" : "alice");
// HOSTILE=1 means this container has cross-mounted OTHER's socket dir.
// In that case cross-mount-attempt is a real fs-perms test and ENOENT
// is a FAIL (the other dir is mounted; we expected EACCES, not "not mounted").
const HOSTILE = process.env.HOSTILE === "1";
// SAME_UID_TWIN: this container has been assigned (by operator
// misconfiguration in compose) the SAME uid as the victim agent. The
// path-derived identity model assumes uid uniqueness across services;
// with that assumption violated, fs perms cannot tell us apart from
// the legitimate agent. Every attack against the victim's dir is
// expected to SUCCEED here. We invert each test's pass criterion so
// the row exits 0 only when the attacks succeed — proving the model
// assumption and motivating the doctor-level UID-uniqueness check
// (Phase 1 backlog).
const SAME_UID_TWIN = process.env.SAME_UID_TWIN === "1";

const SELF_SOCK = `/run/switchroom/broker/${SELF}/sock`;
const OTHER_SOCK = `/run/switchroom/broker/${OTHER}/sock`;
const OTHER_DIR = `/run/switchroom/broker/${OTHER}`;

function rpc(sock, req, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch {}
      resolve(result);
    };
    const t = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => { buf += d.toString("utf8"); });
    c.on("end", () => {
      clearTimeout(t);
      const line = buf.split("\n")[0];
      try { finish({ kind: "ok", resp: JSON.parse(line) }); }
      catch (e) { finish({ kind: "bad-resp", raw: buf }); }
    });
    c.on("error", (e) => { clearTimeout(t); finish({ kind: "error", code: e.code, message: e.message }); });
  });
}

function inspect(p) {
  try {
    const s = fs.statSync(p);
    return { exists: true, mode: (s.mode & 0o777).toString(8), uid: s.uid, gid: s.gid };
  } catch (e) {
    return { exists: false, code: e.code };
  }
}

const out = { agent: SELF, other: OTHER, hostile: HOSTILE, sameUidTwin: SAME_UID_TWIN, uid: process.getuid(), gid: process.getgid(), tests: [] };

// SAME_UID_TWIN short-circuit: we ONLY run attacks against OTHER's
// dir/socket and we EXPECT each one to succeed. The point of this row
// is to document the model's assumption: path-derived identity with
// fs-perm enforcement collapses if two services share a uid. We exit 0
// when the attacks succeed (matching the documented expectation), so
// this row is a positive assertion about the model's failure mode, not
// a green-tee on a real defence.
if (SAME_UID_TWIN) {
  console.log(`# SAME_UID_TWIN mode — uid=${process.getuid()} colliding with victim '${OTHER}'`);
  console.log(`# expected outcome: ALL attacks succeed; this proves the model's uid-uniqueness assumption`);
  console.log(`# victim dir: ${OTHER_DIR} -> ${JSON.stringify(inspect(OTHER_DIR))}`);
  console.log(`# victim sock: ${OTHER_SOCK} -> ${JSON.stringify(inspect(OTHER_SOCK))}`);

  // a. connect() to victim's broker socket and attempt a privileged read.
  const connectResult = await rpc(OTHER_SOCK, { op: "read", key: `${OTHER}-secret` });
  // We expect the connect to succeed at the kernel layer — the broker
  // resolves identity from PATH, not uid, so it will respond as if we
  // were the legitimate victim (path-derived identity is the bug under
  // this threat model). connect-pass means kind === "ok" with ok:true.
  const connectPass = connectResult.kind === "ok" && connectResult.resp?.ok === true;
  out.tests.push({ name: "same-uid-connect-as-victim", expect: "attack-succeeds", result: connectResult, pass: connectPass });
  console.log(`# test same-uid-connect-as-victim: pass=${connectPass} (attack-succeeds expected) result=${JSON.stringify(connectResult)}`);

  // b. bind() a fresh socket inside victim's dir.
  const intruderPath = path.join(OTHER_DIR, "intruder-twin.sock");
  const bindResult = await new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.on("error", (e) => resolve({ kind: "error", code: e.code, message: e.message }));
    try {
      srv.listen(intruderPath, () => {
        try { srv.close(); } catch {}
        try { fs.unlinkSync(intruderPath); } catch {}
        resolve({ kind: "ok-bound", path: intruderPath });
      });
    } catch (e) {
      resolve({ kind: "error", code: e.code, message: e.message });
    }
  });
  const bindPass = bindResult.kind === "ok-bound";
  out.tests.push({ name: "same-uid-bind-into-victim-dir", expect: "attack-succeeds", result: bindResult, pass: bindPass });
  console.log(`# test same-uid-bind-into-victim-dir: pass=${bindPass} (attack-succeeds expected) result=${JSON.stringify(bindResult)}`);

  // c. unlink() the victim's broker socket.
  let unlinkResult;
  try {
    fs.unlinkSync(OTHER_SOCK);
    unlinkResult = { kind: "ok-unlinked" };
  } catch (e) {
    unlinkResult = { kind: "error", code: e.code, message: e.message };
  }
  const unlinkPass = unlinkResult.kind === "ok-unlinked";
  out.tests.push({ name: "same-uid-unlink-victim-sock", expect: "attack-succeeds", result: unlinkResult, pass: unlinkPass });
  console.log(`# test same-uid-unlink-victim-sock: pass=${unlinkPass} (attack-succeeds expected) result=${JSON.stringify(unlinkResult)}`);

  const allPass = out.tests.every((t) => t.pass);
  console.log(JSON.stringify({ summary: { agent: SELF, mode: "same-uid-twin", allPass, count: out.tests.length, passed: out.tests.filter(x=>x.pass).length, note: "row asserts model assumption: uid-uniqueness MUST hold; doctor enforces it in Phase 1" }, tests: out.tests }, null, 2));
  process.exit(allPass ? 0 : 1);
}

console.log(`# agent-client running as ${SELF} (uid=${process.getuid()})`);
console.log(`# self sock dir: ${path.dirname(SELF_SOCK)} -> ${JSON.stringify(inspect(path.dirname(SELF_SOCK)))}`);
console.log(`# self sock:     ${SELF_SOCK} -> ${JSON.stringify(inspect(SELF_SOCK))}`);
console.log(`# other sock dir: ${path.dirname(OTHER_SOCK)} -> ${JSON.stringify(inspect(path.dirname(OTHER_SOCK)))}`);
console.log(`# other sock:    ${OTHER_SOCK} -> ${JSON.stringify(inspect(OTHER_SOCK))}`);

// In hostile mode the other dir IS mounted; we expect EACCES specifically
// (kernel fs-perms boundary). In non-hostile mode the other dir is NOT
// mounted; ENOENT is the only acceptable outcome and is labelled "n/a —
// not mounted (compose discipline boundary, not file-perm boundary)".
const tests = [
  { name: "allow-own-key",    sock: SELF_SOCK,  req: { op: "read", key: `${SELF}-secret` },  expect: "ok" },
  { name: "deny-own-unknown", sock: SELF_SOCK,  req: { op: "read", key: `nonexistent-key` }, expect: "deny" },
  { name: "deny-other-key",   sock: SELF_SOCK,  req: { op: "read", key: `${OTHER}-secret` }, expect: "deny" },
  HOSTILE
    ? { name: "cross-mount-attempt-hostile", sock: OTHER_SOCK, req: { op: "read", key: `${OTHER}-secret` }, expect: "fs-perm-block" }
    : { name: "cross-mount-attempt-na",      sock: OTHER_SOCK, req: { op: "read", key: `${OTHER}-secret` }, expect: "not-mounted" },
];

for (const t of tests) {
  const r = await rpc(t.sock, t.req);
  let pass = false;
  if (t.expect === "ok")   pass = r.kind === "ok" && r.resp?.ok === true;
  if (t.expect === "deny") pass = r.kind === "ok" && r.resp?.ok === false && r.resp?.error === "acl-deny";
  if (t.expect === "fs-perm-block") {
    // Real adversarial test: the other dir IS mounted in this container's
    // namespace. We require the kernel to block at connect() with EACCES /
    // EPERM. ENOENT here would mean the mount didn't take and is NOT a pass.
    pass = r.kind === "error" && (r.code === "EACCES" || r.code === "EPERM");
  }
  if (t.expect === "not-mounted") {
    // The other agent's dir is not in this container's mount tree; ENOENT
    // is the correct, *non-tautological* outcome. We label it explicitly
    // so the matrix doesn't conflate it with a file-perm denial.
    pass = r.kind === "error" && r.code === "ENOENT";
  }
  out.tests.push({ ...t, result: r, pass });
  console.log(`# test ${t.name}: pass=${pass} result=${JSON.stringify(r)}`);
}

// Adversarial bind/unlink tests — only meaningful in hostile mode where
// the other agent's directory is actually visible from this container's
// namespace. In non-hostile mode there is nothing to bind into.
if (HOSTILE) {
  // a. attempt to bind() a fresh socket inside OTHER's dir.
  const intruderPath = path.join(OTHER_DIR, "intruder.sock");
  const bindResult = await new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.on("error", (e) => resolve({ kind: "error", code: e.code, message: e.message }));
    try {
      srv.listen(intruderPath, () => {
        try { srv.close(); } catch {}
        try { fs.unlinkSync(intruderPath); } catch {}
        resolve({ kind: "ok-bound", path: intruderPath });
      });
    } catch (e) {
      resolve({ kind: "error", code: e.code, message: e.message });
    }
  });
  const bindPass = bindResult.kind === "error" && (bindResult.code === "EACCES" || bindResult.code === "EPERM");
  out.tests.push({ name: "bind-into-other-dir", sock: OTHER_DIR, req: null, expect: "fs-perm-block", result: bindResult, pass: bindPass });
  console.log(`# test bind-into-other-dir: pass=${bindPass} result=${JSON.stringify(bindResult)}`);

  // b. attempt to unlink() the other agent's socket inode.
  let unlinkResult;
  try {
    fs.unlinkSync(OTHER_SOCK);
    unlinkResult = { kind: "ok-unlinked" };
  } catch (e) {
    unlinkResult = { kind: "error", code: e.code, message: e.message };
  }
  const unlinkPass = unlinkResult.kind === "error" && (unlinkResult.code === "EACCES" || unlinkResult.code === "EPERM");
  out.tests.push({ name: "unlink-other-sock", sock: OTHER_SOCK, req: null, expect: "fs-perm-block", result: unlinkResult, pass: unlinkPass });
  console.log(`# test unlink-other-sock: pass=${unlinkPass} result=${JSON.stringify(unlinkResult)}`);

  // c. attempt to replace it (open with O_CREAT|O_TRUNC).
  let replaceResult;
  try {
    const fd = fs.openSync(OTHER_SOCK, "w");
    fs.closeSync(fd);
    replaceResult = { kind: "ok-replaced" };
  } catch (e) {
    replaceResult = { kind: "error", code: e.code, message: e.message };
  }
  const replacePass = replaceResult.kind === "error" && (replaceResult.code === "EACCES" || replaceResult.code === "EPERM");
  out.tests.push({ name: "replace-other-sock", sock: OTHER_SOCK, req: null, expect: "fs-perm-block", result: replaceResult, pass: replacePass });
  console.log(`# test replace-other-sock: pass=${replacePass} result=${JSON.stringify(replaceResult)}`);
}

const allPass = out.tests.every((t) => t.pass);
console.log(JSON.stringify({ summary: { agent: SELF, allPass, count: out.tests.length, passed: out.tests.filter(x=>x.pass).length }, tests: out.tests }, null, 2));
process.exit(allPass ? 0 : 1);
