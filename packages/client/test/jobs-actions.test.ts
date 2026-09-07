/**
 * KiCad >= 11.0 conveniences against the fake transport: async jobs (`Job.wait()` polling
 * `GetJobStatus`, progress from polling and from `JobProgress` events, inline outputs), tool
 * actions (`GetActions` / `RunAction`), and `Document.getItemsSince` feeding
 * `DocumentSync.syncSince()` (delta vs. full answers decided against `GetItemCounts`).
 */
import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  ApiStatusCode,
  BoardLayer,
  DocumentSpecifierSchema,
  DocumentType,
  EventSchema,
  GetActionsResponseSchema,
  GetActionsSchema,
  GetItemCountsResponseSchema,
  GetItemCountsSchema,
  GetItemsByIdSchema,
  GetItemsResponseSchema,
  GetItemsSchema,
  GetJobStatusResponseSchema,
  GetJobStatusSchema,
  JobState,
  JobStatus,
  KiCadObjectType,
  RunActionResponseSchema,
  RunActionSchema,
  RunActionStatus,
  RunBoardJobExportGerbersSchema,
  RunJobResponseSchema,
} from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { ActionError, JobError } from "../src/errors";
import { KiCadEvents } from "../src/events";
import { Board, KiCad, Track } from "../src/model";
import { mm } from "../src/units";
import { FakeTransport, fail, reply } from "./fake-transport";

const DOC = create(DocumentSpecifierSchema, {
  type: DocumentType.DOCTYPE_PCB,
  identifier: { case: "boardFilename", value: "x.kicad_pcb" },
});

function track(id: string, layer = BoardLayer.BL_F_Cu): Track {
  const t = new Track();
  t.id = id;
  t.layerId = layer;
  t.width = mm(0.2);
  return t;
}

async function board(t: FakeTransport): Promise<Board> {
  const c = await KiCadClient.connect(t, { clientName: "fp-pcb/test" });
  return new Board(new KiCad(c), DOC);
}

describe("async jobs", () => {
  test("{ async, returnInline } -> JS_RUNNING result with a Job; wait() polls GetJobStatus, reports progress, returns inline outputs", async () => {
    const t = new FakeTransport();
    let polls = 0;
    t.on(RunBoardJobExportGerbersSchema, (req) => {
      expect(req.jobSettings?.async).toBe(true);
      expect(req.jobSettings?.returnInline).toBe(true);
      expect(req.jobSettings?.outputPath).toBe("/out");
      return reply(RunJobResponseSchema, { status: JobStatus.JS_RUNNING, jobId: "job-1" });
    });
    t.on(GetJobStatusSchema, (req) => {
      polls++;
      if (polls < 3)
        return reply(GetJobStatusResponseSchema, {
          jobId: req.jobId,
          state: JobState.RUNNING,
          percent: polls * 40,
          description: `step ${polls}`,
        });
      return reply(GetJobStatusResponseSchema, {
        jobId: req.jobId,
        state: JobState.FINISHED,
        percent: 100,
        description: "done",
        result: {
          status: JobStatus.JS_SUCCESS,
          outputPath: ["/out/a.gbr"],
          jobId: req.jobId,
          inlineOutputs: [{ path: "/out/a.gbr", data: new TextEncoder().encode("G04*") }],
        },
      });
    });
    const b = await board(t);
    const r = await b.jobs.exportGerbers("/out", {}, { async: true, returnInline: true });
    expect(r.running).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.jobId).toBe("job-1");
    expect(r.job?.id).toBe("job-1");
    const progress: string[] = [];
    const done = await r.job!.wait({ intervalMs: 1, onProgress: (p) => progress.push(`${p.percent}:${p.description}:${p.finished}`) });
    expect(done.running).toBe(false);
    expect(done.ok).toBe(true);
    expect(done.status).toBe(JobStatus.JS_SUCCESS);
    expect(done.outputPaths).toEqual(["/out/a.gbr"]);
    expect(done.inlineOutputs.map((o) => o.path)).toEqual(["/out/a.gbr"]);
    expect(new TextDecoder().decode(done.inlineOutputs[0]!.data)).toBe("G04*");
    expect(progress).toEqual(["40:step 1:false", "80:step 2:false", "100:done:true"]);
    expect(polls).toBe(3);
    // a job id can be re-resolved through the document or the root
    expect(b.jobs.job("job-1").id).toBe("job-1");
    expect(b.kicad.job("job-1").command).toBe("Job");
  });

  test("a synchronous job keeps the old shape (ok, not running) and carries the job id + inline outputs", async () => {
    const t = new FakeTransport().on(RunBoardJobExportGerbersSchema, (req) => {
      expect(req.jobSettings?.async).toBe(false);
      return reply(RunJobResponseSchema, { status: JobStatus.JS_WARNING, message: "meh", outputPath: ["/out/a.gbr"], jobId: "job-2" });
    });
    const b = await board(t);
    const r = await b.jobs.exportGerbers("/out");
    expect(r).toMatchObject({ ok: true, running: false, status: JobStatus.JS_WARNING, jobId: "job-2", message: "meh", inlineOutputs: [] });
    await expect(b.jobs.exportGerbers("/out", {}, { failOnWarning: true })).rejects.toBeInstanceOf(JobError);
  });

  test("wait() turns a JS_ERROR result into JobError (with the job id) and gives up after timeoutMs", async () => {
    const t = new FakeTransport().on(GetJobStatusSchema, (req) =>
      req.jobId === "bad"
        ? reply(GetJobStatusResponseSchema, {
            jobId: "bad",
            state: JobState.FINISHED,
            result: { status: JobStatus.JS_ERROR, message: "boom", jobId: "bad" },
          })
        : reply(GetJobStatusResponseSchema, { jobId: req.jobId, state: JobState.RUNNING, percent: 1 }),
    );
    const b = await board(t);
    const err = await b.jobs.wait("bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).jobId).toBe("bad");
    expect((err as JobError).message).toContain("boom");
    const slow = await b.jobs.wait("slow", { intervalMs: 1, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(slow).toBeInstanceOf(JobError);
    expect((slow as JobError).message).toContain("timed out");
    // an unknown id is the server's AS_BAD_REQUEST, passed through
    t.on(GetJobStatusSchema, () => fail(ApiStatusCode.AS_BAD_REQUEST, "unknown job id"));
    await expect(b.jobs.status("nope")).rejects.toMatchObject({ code: ApiStatusCode.AS_BAD_REQUEST });
  });

  test("JobProgress events feed onProgress and wake wait() before the next poll", async () => {
    let finished = false;
    const t = new FakeTransport().on(GetJobStatusSchema, () =>
      finished
        ? reply(GetJobStatusResponseSchema, {
            jobId: "job-3",
            state: JobState.FINISHED,
            percent: 100,
            description: "done",
            result: { status: JobStatus.JS_SUCCESS, jobId: "job-3" },
          })
        : reply(GetJobStatusResponseSchema, { jobId: "job-3", state: JobState.RUNNING, percent: 0, description: "queued" }),
    );
    const b = await board(t);
    const events = new KiCadEvents();
    const progress: string[] = [];
    const started = performance.now();
    const waiting = b.jobs.wait("job-3", {
      intervalMs: 60_000,
      events,
      onProgress: (p) => progress.push(`${p.percent}:${p.description}:${p.finished}`),
    });
    await Bun.sleep(5);
    const push = (seq: bigint, percent: number, description: string, done: boolean) =>
      events.push(
        toBinary(
          EventSchema,
          create(EventSchema, {
            sequence: seq,
            kind: { case: "jobProgress", value: { jobId: "job-3", percent, description, finished: done } },
          }),
        ),
      );
    push(1n, 50, "half", false);
    // an event for another job is ignored
    events.push(
      toBinary(
        EventSchema,
        create(EventSchema, {
          sequence: 2n,
          kind: { case: "jobProgress", value: { jobId: "other", percent: 99, description: "x", finished: true } },
        }),
      ),
    );
    finished = true;
    push(3n, 100, "done", true);
    const r = await waiting;
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.ok).toBe(true);
    expect(progress).toEqual(["0:queued:false", "50:half:false", "100:done:true"]);
    expect(t.countOf(GetJobStatusSchema)).toBe(2);
  });
});

describe("tool actions", () => {
  test("actions() / headlessActions() / runAction() with ActionError for RAS_INVALID", async () => {
    const t = new FakeTransport()
      .on(GetActionsSchema, (req) => {
        expect(req.document?.type).toBe(DocumentType.DOCTYPE_PCB);
        return reply(GetActionsResponseSchema, {
          actions: [
            { name: "pcbnew.ZoneFiller.zoneFillAll", label: "Fill All Zones", description: "", headlessCapable: true },
            { name: "pcbnew.InteractiveSelection.ClearSelection", label: "Clear", description: "", headlessCapable: false },
          ],
        });
      })
      .on(RunActionSchema, (req) =>
        reply(RunActionResponseSchema, {
          status: req.action === "pcbnew.ZoneFiller.zoneFillAll" ? RunActionStatus.RAS_OK : RunActionStatus.RAS_INVALID,
        }),
      );
    const b = await board(t);
    expect((await b.actions()).length).toBe(2);
    expect((await b.headlessActions()).map((a) => a.name)).toEqual(["pcbnew.ZoneFiller.zoneFillAll"]);
    expect(await b.runAction("pcbnew.ZoneFiller.zoneFillAll")).toBe(RunActionStatus.RAS_OK);
    const err = await b.runAction("pcbnew.InteractiveSelection.ClearSelection").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(RunActionStatus.RAS_INVALID);
    expect((err as ActionError).statusName).toBe("RAS_INVALID");
    expect(t.requestsOf(RunActionSchema).map((r) => r.action)).toEqual([
      "pcbnew.ZoneFiller.zoneFillAll",
      "pcbnew.InteractiveSelection.ClearSelection",
    ]);
  });
});

describe("getItemsSince + DocumentSync.syncSince", () => {
  /** Server at revision 5 with tracks t1..t3; t2 changed and t9 deleted after revision 3. */
  function sinceTransport() {
    const t1 = track("t1");
    const t2 = track("t2");
    const t3 = track("t3");
    const t2b = track("t2", BoardLayer.BL_B_Cu);
    const all = [t1, t2, t3].map((x) => x.toAny());
    const t = new FakeTransport()
      .on(GetItemsByIdSchema, (req) => reply(GetItemsResponseSchema, { items: req.items.map((k) => track(k.value).toAny()), revision: 5n }))
      .on(GetItemCountsSchema, () =>
        reply(GetItemCountsResponseSchema, {
          counts: [
            { type: KiCadObjectType.KOT_PCB_TRACE, count: 3 },
            { type: KiCadObjectType.KOT_PCB_VIA, count: 0 },
          ],
          revision: 5n,
        }),
      )
      .on(GetItemsSchema, (req) => {
        expect(req.header?.document?.type).toBe(DocumentType.DOCTYPE_PCB);
        const since = req.sinceRevision;
        if (since === undefined) return reply(GetItemsResponseSchema, { items: all, total: 3, revision: 5n });
        if (since >= 5n) return reply(GetItemsResponseSchema, { items: [], total: 0, revision: 5n });
        if (since === 3n)
          return reply(GetItemsResponseSchema, { items: [t2b.toAny()], deletedIds: [{ value: "t9" }], total: 1, revision: 5n });
        // too old for the change log: KiCad answers with everything
        return reply(GetItemsResponseSchema, { items: all, total: 3, revision: 5n });
      });
    return t;
  }

  test("getItemsSince(): delta, nothing-changed and full answers", async () => {
    const b = await board(sinceTransport());
    const delta = await b.getItemsSince(3n, [KiCadObjectType.KOT_PCB_TRACE]);
    expect(delta.full).toBe(false);
    expect(delta.items.map((i) => i.id)).toEqual(["t2"]);
    expect(delta.deletedIds).toEqual(["t9"]);
    expect(delta.revision).toBe(5n);
    const none = await b.getItemsSince(5n, [KiCadObjectType.KOT_PCB_TRACE]);
    expect(none).toEqual({ items: [], deletedIds: [], revision: 5n, full: false });
    const old = await b.getItemsSince(1n, [KiCadObjectType.KOT_PCB_TRACE]);
    expect(old.full).toBe(true);
    expect(old.items.map((i) => i.id)).toEqual(["t1", "t2", "t3"]);
    const initial = await b.getItemsSince(undefined, [KiCadObjectType.KOT_PCB_TRACE]);
    expect(initial.full).toBe(true);
    expect(initial.revision).toBe(5n);
    const page = await b.getItemsPage(KiCadObjectType.KOT_PCB_TRACE, { offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.revision).toBe(5n);
    const counts = await b.itemCounts();
    expect(counts.counts.get(KiCadObjectType.KOT_PCB_TRACE)).toBe(3);
    expect(counts.total).toBe(3);
    expect(counts.revision).toBe(5n);
  });

  test("DocumentSync: load() records the revision; refresh() goes incremental; full answers replace", async () => {
    const t = sinceTransport();
    const b = await board(t);
    const sync = b.documentSync;
    expect(sync.revision).toBeUndefined();
    await sync.load();
    expect(sync.revision).toBe(5n);
    expect(sync.store.size).toBe(3);
    expect(await sync.supportsIncrementalSync()).toBe(true); // bundled capability table lists GetItemCounts
    const diffs: { added: string[]; updated: string[]; removed: string[] }[] = [];
    sync.store.subscribe((d) => diffs.push({ added: d.added.map((i) => i.id), updated: d.updated.map((i) => i.id), removed: d.removed }));

    // nothing changed since 5: refresh() is one GetItemCounts + one GetItems(since 5) and no diff
    const before = t.countOf(GetItemsSchema);
    await sync.refresh();
    expect(t.countOf(GetItemsSchema)).toBe(before + 1);
    expect(t.requestsOf(GetItemsSchema).at(-1)!.sinceRevision).toBe(5n);
    expect(diffs).toEqual([]);

    // an explicit older revision: delta merge (t2 updated; t9 unknown to the store -> nothing removed)
    await sync.syncSince(3n);
    expect(diffs).toEqual([{ added: [], updated: ["t2"], removed: [] }]);
    expect(sync.store.get("t2")!.layer).toBe("BL_B_Cu");
    expect(sync.revision).toBe(5n);

    // a full answer replaces the content (t2 back to F.Cu, a stale local item dropped)
    sync.store.applyItems({ added: [track("stale")] });
    diffs.length = 0;
    await sync.syncSince(1n);
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.removed).toEqual(["stale"]);
    expect(diffs[0]!.updated).toEqual(["t1", "t2", "t3"]); // new proto objects from the server
    expect(sync.store.get("t2")!.layer).toBe("BL_F_Cu");

    // an event revision moves the store's revision forward, never back
    await sync.syncIds({ updated: ["t1"], revision: 7n });
    expect(sync.revision).toBe(7n);
    await sync.syncIds({ updated: ["t1"], revision: 6n });
    expect(sync.revision).toBe(7n);
  });
});
