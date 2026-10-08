/**
 * Ports for tests that need a world port to stay closed, or to be bound later by the test itself (YOS-105).
 *
 * A port read from a port-0 probe and then closed goes back to the OS's ephemeral pool, and any process binding port 0
 * meanwhile can be handed it: under node --test --test-concurrency=2 a parallel test file did, and the studio's API
 * console tests failed with EADDRINUSE. quietPort() returns a free port below every default ephemeral range (Linux
 * starts at 32768, macOS at 49152), where a bind to port 0 never lands, so only a process naming that exact port could
 * take it.
 */
import { createServer } from 'node:net';

const QUIET_FIRST = 20000;
const QUIET_COUNT = 12000;

function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * A loopback port in 20000..31999 with nothing listening on it or on the `span - 1` ports after it, such as a world port
 * whose admin port defaults to port + 1, starting from an offset of this process's pid.
 */
export async function quietPort(span = 1): Promise<number> {
  const start = (process.pid * 37) % QUIET_COUNT;
  for (let i = 0; i < QUIET_COUNT; i++) {
    const port = QUIET_FIRST + ((start + i) % (QUIET_COUNT - span + 1));
    let all = true;
    for (let k = 0; k < span && all; k++) all = await free(port + k);
    if (all) return port;
  }
  throw new Error(`no free loopback port in ${QUIET_FIRST}..${QUIET_FIRST + QUIET_COUNT - 1}`);
}
