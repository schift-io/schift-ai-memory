import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createAiMemoryEvent, drainOutbox, enqueueEvent, outboxStatus } from "../dist/index.js";

async function queueWith(count) {
  const dir = await mkdtemp(join(tmpdir(), "schift-outbox-"));
  for (let i = 0; i < count; i += 1) {
    await enqueueEvent(
      dir,
      createAiMemoryEvent({
        source: "codex",
        harness: "test",
        event_kind: "ai_job_summary",
        job: { type: "coding", title: `job ${i}`, status: "completed" },
      }),
    );
  }
  return dir;
}

/** 시계를 주입한다. 백오프는 시간이 핵심이라 실제 시간으로는 검증이 안 된다. */
function clock(startMs = 1_000_000) {
  let now = startMs;
  return { now: () => now, advance: (ms) => (now += ms) };
}

async function eventFiles(dir) {
  return (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.endsWith(".state.json"));
}

describe("outbox", () => {
  it("delivers and removes queued events", async () => {
    const dir = await queueWith(3);
    const seen = [];
    const report = await drainOutbox(dir, async (event) => {
      seen.push(event.job.title);
      return { ok: true, status: 200 };
    });
    assert.equal(report.delivered, 3);
    // 같은 밀리초에 만들어지면 파일명 정렬이 생성 순서를 보장하지 않는다.
    // 순서가 아니라 **하나도 빠지지 않았는지**가 계약이다.
    assert.deepEqual(seen.sort(), ["job 0", "job 1", "job 2"]);
    assert.deepEqual(await eventFiles(dir), [], "delivered events must not stay queued");
  });

  it("backs off on transient failure instead of hammering", async () => {
    const dir = await queueWith(1);
    const c = clock();
    let calls = 0;
    const deliver = async () => {
      calls += 1;
      return { ok: false, status: 503, error: "upstream unavailable" };
    };

    const first = await drainOutbox(dir, deliver, { now: c.now, baseDelayMs: 30_000 });
    assert.equal(first.retrying, 1);
    assert.equal(calls, 1);

    // 곧바로 다시 돌려도 **보내지 않는다**. 이게 없으면 훅이 뜰 때마다 죽은
    // 엔드포인트를 두드린다.
    const second = await drainOutbox(dir, deliver, { now: c.now });
    assert.equal(calls, 1, "must not retry before the backoff window");
    assert.equal(second.deferred, 1);

    c.advance(31_000);
    const third = await drainOutbox(dir, deliver, { now: c.now });
    assert.equal(calls, 2, "must retry once the window passes");
    assert.equal(third.retrying, 1);

    // 백오프가 실제로 커지는지 — 두 번째 대기는 첫 번째보다 길어야 한다.
    const stateName = (await readdir(dir)).find((n) => n.endsWith(".state.json"));
    const state = JSON.parse(await readFile(join(dir, stateName), "utf8"));
    assert.equal(state.attempts, 2);
    assert.ok(
      Date.parse(state.next_attempt_at) - c.now() > 31_000,
      "second wait must exceed the first",
    );
  });

  it("quarantines immediately when retrying cannot help", async () => {
    const dir = await queueWith(1);
    let calls = 0;
    // 401 = 키가 폐기됨. 여덟 번 더 보내도 같은 답이 온다.
    const report = await drainOutbox(dir, async () => {
      calls += 1;
      return { ok: false, status: 401, error: "revoked" };
    });
    assert.equal(calls, 1);
    assert.equal(report.quarantined, 1);
    assert.deepEqual(await eventFiles(dir), [], "quarantined events leave the active queue");

    // 버리지 않는다 — 왜 안 올라갔는지 남아 있어야 한다.
    const held = await readdir(join(dir, "quarantine"));
    assert.equal(held.filter((n) => !n.endsWith(".state.json")).length, 1);
    const state = JSON.parse(
      await readFile(join(dir, "quarantine", held.find((n) => n.endsWith(".state.json"))), "utf8"),
    );
    assert.equal(state.last_status, 401);
    assert.match(state.last_error, /revoked/);
  });

  it("gives up after maxAttempts on a failure that stays transient", async () => {
    const dir = await queueWith(1);
    const c = clock();
    for (let i = 0; i < 3; i += 1) {
      await drainOutbox(dir, async () => ({ ok: false, status: 500 }), {
        now: c.now,
        maxAttempts: 3,
        baseDelayMs: 1,
      });
      c.advance(60 * 60 * 1000);
    }
    assert.deepEqual(await eventFiles(dir), []);
    assert.equal((await readdir(join(dir, "quarantine"))).length, 2);
  });

  it("does not send the same event twice when two drains overlap", async () => {
    const dir = await queueWith(1);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const deliver = async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return { ok: true, status: 200 };
    };
    await Promise.all([drainOutbox(dir, deliver), drainOutbox(dir, deliver)]);
    assert.equal(maxInFlight, 1, "lease must serialize delivery");
    assert.equal(calls, 1, "a leased event must not be picked up twice");
  });

  it("never throws when delivery blows up — the host session must survive", async () => {
    const dir = await queueWith(1);
    const report = await drainOutbox(dir, async () => {
      throw new Error("socket exploded");
    });
    assert.equal(report.retrying, 1);
    const stateName = (await readdir(dir)).find((n) => n.endsWith(".state.json"));
    const state = JSON.parse(await readFile(join(dir, stateName), "utf8"));
    assert.match(state.last_error, /socket exploded/);
  });

  it("quarantines unreadable files instead of retrying them forever", async () => {
    const dir = await queueWith(0);
    await writeFile(join(dir, "2026-08-06T00-00-00-000Z-broken.json"), "{ not json", "utf8");
    const report = await drainOutbox(dir, async () => ({ ok: true, status: 200 }));
    assert.equal(report.quarantined, 1);
    assert.equal(report.delivered, 0);
  });

  it("reports backlog so doctor can show an unattended queue", async () => {
    const dir = await queueWith(2);
    const c = clock();
    await drainOutbox(dir, async () => ({ ok: false, status: 503, error: "down" }), { now: c.now });
    const status = await outboxStatus(dir, c.now);
    assert.equal(status.pending, 2, "nothing was delivered, so nothing left the queue");
    assert.equal(status.due, 0, "both are waiting out their backoff");
    assert.match(status.last_error, /down/);

    c.advance(60_000);
    assert.equal((await outboxStatus(dir, c.now)).due, 2, "both become due once the window passes");
  });

  it("honors the per-run limit so a hook cannot stall a session", async () => {
    const dir = await queueWith(10);
    const report = await drainOutbox(dir, async () => ({ ok: true, status: 200 }), { limit: 4 });
    assert.equal(report.delivered, 4);
    assert.equal((await eventFiles(dir)).length, 6);
  });
});
