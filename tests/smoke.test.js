const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");

const rootDir = path.join(__dirname, "..");
const port = 3100 + Math.floor(Math.random() * 400);
const baseUrl = `http://127.0.0.1:${port}`;

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      SESSION_SECRET: process.env.SESSION_SECRET || "test-session-secret"
    };

    const child = spawn(process.execPath, ["server.js"], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let output = "";

    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (!settled && text.includes("Server running on http://localhost:")) {
        settled = true;
        resolve(child);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited early with code ${code}.\n${output}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Timed out waiting for server start.\n${output}`));
      }
    }, 15000);
  });
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    ...options
  });
  return response;
}

async function run() {
  let server;

  try {
    server = await startServer();

    const rootRes = await request("/");
    assert.strictEqual(rootRes.status, 200, "GET / should return 200");

    const loginRes = await request("/login");
    assert.strictEqual(loginRes.status, 200, "GET /login should return 200");

    const registerRes = await request("/register");
    assert.strictEqual(registerRes.status, 200, "GET /register should return 200");

    const dashboardRes = await request("/dashboard");
    assert.strictEqual(dashboardRes.status, 302, "GET /dashboard should redirect when unauthenticated");
    assert.strictEqual(
      dashboardRes.headers.get("location"),
      "/login",
      "GET /dashboard should redirect to /login"
    );

    console.log("Smoke test passed: core routes and auth redirect are working.");
  } finally {
    if (server && !server.killed) {
      server.kill();
    }
  }
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
