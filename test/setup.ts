import path from "node:path";
import { tmpdir } from "node:os";

// Keep Pi's managed tool cache out of the test environment. A developer may
// have a sandbox-platform binary (for example Linux `fd`) in their normal Pi
// agent directory, which cannot execute on the host running these tests.
process.env.PI_CODING_AGENT_DIR = path.join(tmpdir(), `pi-sbx-test-agent-${process.pid}`);
