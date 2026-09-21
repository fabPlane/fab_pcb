/**
 * Export jobs (`board_jobs.proto`, `schematic_jobs.proto`). Every method sets `job_settings`
 * (document + output path + the KiCad >= 11.0 `async` / `return_inline` flags) for you and
 * returns a `JobResult`; `JS_ERROR` throws `JobError`. With `{ async: true }` the result comes
 * back `running` with a `Job` handle: `job.wait()` polls `GetJobStatus` (and listens to
 * `JobProgress` events when given a `KiCadEvents`) until the job finishes.
 */
import type { DescMessage, MessageInitShape } from "@bufbuild/protobuf";
import {
  JobState,
  JobStatus,
  RunBoardJobExport3DSchema,
  RunBoardJobExportDrillSchema,
  RunBoardJobExportDxfSchema,
  RunBoardJobExportSpecctraSchema,
  RunBoardJobExportGencadSchema,
  RunBoardJobExportGerbersSchema,
  RunBoardJobExportIpc2581Schema,
  RunBoardJobExportIpcD356Schema,
  RunBoardJobExportODBSchema,
  RunBoardJobExportPdfSchema,
  RunBoardJobExportPngSchema,
  RunBoardJobExportPositionSchema,
  RunBoardJobExportPsSchema,
  RunBoardJobExportRenderSchema,
  RunBoardJobExportStatsSchema,
  RunBoardJobExportSvgSchema,
  RunSchematicJobExportBOMSchema,
  RunSchematicJobExportDxfSchema,
  RunSchematicJobExportNetlistSchema,
  RunSchematicJobExportPdfSchema,
  RunSchematicJobExportPngSchema,
  RunSchematicJobExportPsSchema,
  RunSchematicJobExportSvgSchema,
  type GetJobStatusResponse,
  type RunJobResponse,
  type RunJobSettings,
} from "@fp-pcb/proto";
import type { KiCadClient } from "../client";
import * as cmd from "../commands";
import { JobError } from "../errors";
import type { KiCadEvents } from "../events";
import type { Document } from "./document";

/** One output file returned inline (`RunJobSettings.return_inline`). */
export interface JobOutput {
  path: string;
  data: Uint8Array;
}

export interface JobResult {
  status: JobStatus;
  outputPaths: string[];
  message: string;
  /** True for JS_SUCCESS and JS_WARNING. */
  ok: boolean;
  /** Identifier for `GetJobStatus` / `JobProgress` events (empty on servers that predate it). */
  jobId: string;
  /** The outputs' contents when `returnInline` was set and the job has finished. */
  inlineOutputs: JobOutput[];
  /** True when the job was started with `async` and is still running: `job.wait()` gives the final result. */
  running: boolean;
  /** Handle for a running job (`async`); also set on finished jobs that have an id. */
  job?: Job;
}

export interface JobOptions {
  /** Treat `JS_WARNING` as failure too. Default false. */
  failOnWarning?: boolean;
  /**
   * Return as soon as the job is queued (`JS_RUNNING`, `running: true`, `job` set) instead of
   * waiting for it. Honoured by `kicad-cli api-server` (KiCad >= 11.0); an editor window runs
   * the job synchronously regardless, so always check `result.running`.
   */
  async?: boolean;
  /** Also return the output files' contents (`inlineOutputs`; files up to 16 MiB each). */
  returnInline?: boolean;
}

export interface JobProgressInfo {
  jobId: string;
  /** 0..100 */
  percent: number;
  description: string;
  finished: boolean;
}

export interface JobWaitOptions {
  /** Poll interval for `GetJobStatus`. Default 100 ms. */
  intervalMs?: number;
  /** Give up (throwing `JobError`) after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Called whenever the reported progress changes (from polling and, when given, from events). */
  onProgress?: (progress: JobProgressInfo) => void;
  /** When given, `JobProgress` events wake the poll loop as soon as the job finishes. */
  events?: KiCadEvents;
  /** Treat `JS_WARNING` as failure. Default false. */
  failOnWarning?: boolean;
}

/** The job's own fields: everything but `job_settings` (set by the method) and the type tag. */
export type Args<S extends DescMessage> = Omit<MessageInitShape<S>, "jobSettings" | "$typeName">;

function sleep(ms: number, wake?: { resolve?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (wake) wake.resolve = () => (clearTimeout(t), resolve());
  });
}

/** A job KiCad identified (`RunJobResponse.job_id`): poll its status or wait for it to finish. */
export class Job {
  constructor(
    readonly client: KiCadClient,
    readonly id: string,
    /** The `RunBoardJob*` / `RunSchematicJob*` command that started it (for error messages). */
    readonly command = "Job",
  ) {}

  /** `GetJobStatus`; `AS_BAD_REQUEST` when KiCad no longer knows the id. */
  status(): Promise<GetJobStatusResponse> {
    return cmd.getJobStatus(this.client, { jobId: this.id });
  }

  /** Polls `GetJobStatus` until `JOB_STATE_FINISHED`, then returns the final result (or throws `JobError`). */
  async wait(opts: JobWaitOptions = {}): Promise<JobResult> {
    const interval = opts.intervalMs ?? 100;
    const deadline = performance.now() + (opts.timeoutMs ?? 600_000);
    let lastKey = "";
    const report = (p: JobProgressInfo) => {
      const key = `${p.percent}|${p.description}|${p.finished}`;
      if (key === lastKey) return;
      lastKey = key;
      opts.onProgress?.(p);
    };
    const wake: { resolve?: () => void } = {};
    const offEvents = opts.events?.on("jobProgress", (p) => {
      if (p.jobId !== this.id) return;
      report({ jobId: p.jobId, percent: p.percent, description: p.description, finished: p.finished });
      if (p.finished) wake.resolve?.();
    });
    try {
      for (;;) {
        const st = await this.status();
        const finished = st.state === JobState.FINISHED;
        report({ jobId: st.jobId || this.id, percent: st.percent, description: st.description, finished });
        if (finished) {
          if (!st.result) throw new JobError(this.command, "job finished without a result", [], this.id);
          return toResult(this.client, this.command, st.result, opts);
        }
        if (performance.now() >= deadline) throw new JobError(this.command, `timed out waiting for job ${this.id}`, [], this.id);
        await sleep(interval, wake);
        wake.resolve = undefined;
      }
    } finally {
      offEvents?.();
    }
  }
}

function toResult(client: KiCadClient, command: string, res: RunJobResponse, opts?: { failOnWarning?: boolean }): JobResult {
  const running = res.status === JobStatus.JS_RUNNING;
  const ok = res.status === JobStatus.JS_SUCCESS || (res.status === JobStatus.JS_WARNING && !opts?.failOnWarning);
  if (res.status === JobStatus.JS_ERROR || (!ok && !running)) throw new JobError(command, res.message, res.outputPath, res.jobId);
  return {
    status: res.status,
    outputPaths: res.outputPath,
    message: res.message,
    ok,
    jobId: res.jobId,
    inlineOutputs: res.inlineOutputs.map((o) => ({ path: o.path, data: o.data })),
    running,
    job: res.jobId ? new Job(client, res.jobId, command) : undefined,
  };
}

abstract class Jobs {
  constructor(protected readonly doc: Document) {}

  protected settings(outputPath: string, opts: JobOptions = {}): RunJobSettings {
    return {
      $typeName: "kiapi.common.types.RunJobSettings",
      document: this.doc.specifier,
      outputPath,
      async: opts.async ?? false,
      returnInline: opts.returnInline ?? false,
    };
  }

  protected async run(
    command: string,
    outputPath: string,
    opts: JobOptions | undefined,
    send: (jobSettings: RunJobSettings) => Promise<RunJobResponse>,
  ): Promise<JobResult> {
    return toResult(this.doc.client, command, await send(this.settings(outputPath, opts)), opts);
  }

  /** Handle for a job by id (from `JobResult.jobId` or a `JobProgress` event). */
  job(jobId: string): Job {
    return new Job(this.doc.client, jobId);
  }

  /** `GetJobStatus` for a job id. */
  status(jobId: string): Promise<GetJobStatusResponse> {
    return this.job(jobId).status();
  }

  /** Waits for a job started with `{ async: true }` (or any job KiCad still remembers). */
  wait(jobId: string, opts?: JobWaitOptions): Promise<JobResult> {
    return this.job(jobId).wait(opts);
  }
}

export class BoardJobs extends Jobs {
  export3D(outputPath: string, args: Args<typeof RunBoardJobExport3DSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExport3D", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExport3D(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportRender(outputPath: string, args: Args<typeof RunBoardJobExportRenderSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportRender", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportRender(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportSvg(outputPath: string, args: Args<typeof RunBoardJobExportSvgSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportSvg", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportSvg(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportDxf(outputPath: string, args: Args<typeof RunBoardJobExportDxfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportDxf", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportDxf(this.doc.client, { ...args, jobSettings }),
    );
  }
  /**
   * `RunBoardJobExportSpecctra`: the board as a Specctra DSN for an external autorouter such as
   * Freerouting. Like every export job it reads the board file, so save first; pair with
   * `board.importSpecctraSession` to bring the routed session back in one undoable commit.
   */
  exportSpecctra(outputPath: string, args: Args<typeof RunBoardJobExportSpecctraSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportSpecctra", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportSpecctra(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportPdf(outputPath: string, args: Args<typeof RunBoardJobExportPdfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportPdf", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportPdf(this.doc.client, { ...args, jobSettings }),
    );
  }
  /** `RunBoardJobExportPng` (upstream, since 11.0): a raster plot; `dpi` and `antialiasing` in `args`. */
  exportPng(outputPath: string, args: Args<typeof RunBoardJobExportPngSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportPng", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportPng(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportPs(outputPath: string, args: Args<typeof RunBoardJobExportPsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportPs", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportPs(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportGerbers(outputPath: string, args: Args<typeof RunBoardJobExportGerbersSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportGerbers", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportGerbers(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportDrill(outputPath: string, args: Args<typeof RunBoardJobExportDrillSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportDrill", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportDrill(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportPosition(outputPath: string, args: Args<typeof RunBoardJobExportPositionSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportPosition", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportPosition(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportGencad(outputPath: string, args: Args<typeof RunBoardJobExportGencadSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportGencad", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportGencad(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportIpc2581(outputPath: string, args: Args<typeof RunBoardJobExportIpc2581Schema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportIpc2581", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportIpc2581(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportIpcD356(outputPath: string, args: Args<typeof RunBoardJobExportIpcD356Schema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportIpcD356", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportIpcD356(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportOdb(outputPath: string, args: Args<typeof RunBoardJobExportODBSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportODB", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportODB(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportStats(outputPath: string, args: Args<typeof RunBoardJobExportStatsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunBoardJobExportStats", outputPath, opts, (jobSettings) =>
      cmd.runBoardJobExportStats(this.doc.client, { ...args, jobSettings }),
    );
  }
}

export class SchematicJobs extends Jobs {
  exportSvg(outputPath: string, args: Args<typeof RunSchematicJobExportSvgSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportSvg", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportSvg(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportDxf(outputPath: string, args: Args<typeof RunSchematicJobExportDxfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportDxf", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportDxf(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportPdf(outputPath: string, args: Args<typeof RunSchematicJobExportPdfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportPdf", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportPdf(this.doc.client, { ...args, jobSettings }),
    );
  }
  /** `RunSchematicJobExportPng` (upstream, since 11.0): a raster plot; `dpi` and `antialiasing` in `args`. */
  exportPng(outputPath: string, args: Args<typeof RunSchematicJobExportPngSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportPng", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportPng(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportPs(outputPath: string, args: Args<typeof RunSchematicJobExportPsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportPs", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportPs(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportNetlist(outputPath: string, args: Args<typeof RunSchematicJobExportNetlistSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportNetlist", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportNetlist(this.doc.client, { ...args, jobSettings }),
    );
  }
  exportBom(outputPath: string, args: Args<typeof RunSchematicJobExportBOMSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return this.run("RunSchematicJobExportBOM", outputPath, opts, (jobSettings) =>
      cmd.runSchematicJobExportBOM(this.doc.client, { ...args, jobSettings }),
    );
  }
}
