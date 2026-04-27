/**
 * Direct SO_PEERCRED via bun:ffi — connection-bound peer credentials with
 * zero ambiguity under concurrent accepts.
 *
 * Replaces the `ss -xpn` parsing path (issue #129) when running under bun.
 * The kernel attaches credentials to a unix-domain socket at connect()/accept()
 * time, before any user-space code runs, so getsockopt(SO_PEERCRED) returns
 * the unique caller for *this* socket — no race, no inode-pair join, no shell-
 * out. About 40 lines of FFI replace 150 lines of ss-output regex parsing.
 *
 * # When this path is active
 *
 * - bun runtime, Linux: `bun:ffi` is built in, `getsockopt` is in libc.
 *   This is the production path (install.sh bootstraps bun) and the dev path.
 * - node runtime, Linux: bun:ffi import throws → caller falls back to
 *   `peercred.ts`'s ss-based identify(). The ss path was hardened in the
 *   same PR to match by server-socket inode rather than first-row-wins,
 *   so both paths are concurrency-safe; this one is just leaner.
 * - non-Linux: SO_PEERCRED is Linux-specific. The broker refuses to start
 *   on non-Linux at all (see VaultBroker.start), so this module is never
 *   imported there.
 *
 * # The struct ucred wire format
 *
 *   struct ucred {
 *     pid_t pid;   // 4 bytes, little-endian on x86_64/aarch64
 *     uid_t uid;   // 4 bytes
 *     gid_t gid;   // 4 bytes
 *   };
 *
 * Total 12 bytes. Linux pid_t/uid_t/gid_t are all 32-bit on glibc and musl.
 *
 * # Why FFI instead of a native addon
 *
 * A node-gyp/N-API addon would mean a C compile step, a binding.gyp,
 * platform-specific binaries, and a postinstall hook. For a single
 * 4-byte syscall on a single platform, bun:ffi is dramatically simpler.
 * Cost: "broker FFI path requires bun runtime, not node" — fine because
 * install.sh bootstraps bun. npm-only consumers get the ss fallback.
 */

export interface PeerCred {
  pid: number;
  uid: number;
  gid: number;
}

/**
 * Look up SO_PEERCRED for the given socket fd. Returns null on any failure
 * (FFI not available, getsockopt errored, non-Linux). Caller is expected
 * to fall back to the ss-parsing path on null.
 *
 * NOTE: bun:ffi is type-checked under node where the types may not be
 * installed. The require() is wrapped in a runtime try/catch and the
 * `any` cast is intentional — the static type system can't see across
 * runtimes. The runtime guard is what actually matters.
 */
export function getPeerCred(fd: number): PeerCred | null {
  if (process.platform !== "linux") return null;
  try {
    // Lazy-load bun:ffi so the node static type checker doesn't need to
    // resolve bun-only types. The catch below covers "running under node"
    // (where require("bun:ffi") throws ERR_MODULE_NOT_FOUND).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const ffi: any = (require as unknown as (m: string) => unknown)("bun:ffi");
    const { dlopen, FFIType, ptr, suffix } = ffi;

    const SOL_SOCKET = 1;
    const SO_PEERCRED = 17;
    const UCRED_SIZE = 12;

    // Open libc once and cache. Failure on first call is permanent —
    // the symbols are part of glibc/musl and don't disappear at runtime.
    type LibHandle = { symbols: { getsockopt: (...args: unknown[]) => number } };
    type WithCache = ((fd: number) => PeerCred | null) & { _lib?: LibHandle };
    const cache = getPeerCred as WithCache;
    const lib: LibHandle = cache._lib ?? (() => {
      const opened = dlopen(`libc.${suffix}.6`, {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      });
      cache._lib = opened;
      return opened;
    })();

    const credBuf = new ArrayBuffer(UCRED_SIZE);
    const lenBuf = new Uint32Array(1);
    lenBuf[0] = UCRED_SIZE;

    const rc = lib.symbols.getsockopt(
      fd,
      SOL_SOCKET,
      SO_PEERCRED,
      ptr(credBuf),
      ptr(lenBuf.buffer as ArrayBuffer),
    );
    if (rc !== 0) return null;
    if (lenBuf[0] !== UCRED_SIZE) return null;

    const view = new DataView(credBuf);
    return {
      pid: view.getInt32(0, true),
      uid: view.getInt32(4, true),
      gid: view.getInt32(8, true),
    };
  } catch {
    // bun:ffi unavailable (running under node) or any other failure.
    return null;
  }
}
