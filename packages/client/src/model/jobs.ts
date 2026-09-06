/**
 * Export jobs (`board_jobs.proto`, `schematic_jobs.proto`). Every method sets `job_settings`
 * (document + output path) for you and returns the `RunJobResponse`; `JS_ERROR` throws `JobError`.
 */
import type { DescMessage, MessageInitShape } from "@bufbuild/protobuf";
import {
  JobStatus,
  RunBoardJobExport3DSchema,
  RunBoardJobExportDrillSchema,
  RunBoardJobExportDxfSchema,
  RunBoardJobExportGencadSchema,
  RunBoardJobExportGerbersSchema,
  RunBoardJobExportIpc2581Schema,
  RunBoardJobExportIpcD356Schema,
  RunBoardJobExportODBSchema,
  RunBoardJobExportPdfSchema,
  RunBoardJobExportPositionSchema,
  RunBoardJobExportPsSchema,
  RunBoardJobExportRenderSchema,
  RunBoardJobExportStatsSchema,
  RunBoardJobExportSvgSchema,
  RunSchematicJobExportBOMSchema,
  RunSchematicJobExportDxfSchema,
  RunSchematicJobExportNetlistSchema,
  RunSchematicJobExportPdfSchema,
  RunSchematicJobExportPsSchema,
  RunSchematicJobExportSvgSchema,
  type RunJobResponse,
  type RunJobSettings,
} from "@kicad-web/proto";
import * as cmd from "../commands";
import { JobError } from "../errors";
import type { Document } from "./document";

export interface JobResult {
  status: JobStatus;
  outputPaths: string[];
  message: string;
  /** True for JS_SUCCESS and JS_WARNING. */
  ok: boolean;
}

export interface JobOptions {
  /** Treat `JS_WARNING` as failure too. Default false. */
  failOnWarning?: boolean;
}

/** The job's own fields: everything but `job_settings` (set by the method) and the type tag. */
export type Args<S extends DescMessage> = Omit<MessageInitShape<S>, "jobSettings" | "$typeName">;

function toResult(command: string, res: RunJobResponse, opts?: JobOptions): JobResult {
  const ok = res.status === JobStatus.JS_SUCCESS || (res.status === JobStatus.JS_WARNING && !opts?.failOnWarning);
  if (res.status === JobStatus.JS_ERROR || !ok) throw new JobError(command, res.message, res.outputPath);
  return { status: res.status, outputPaths: res.outputPath, message: res.message, ok };
}

abstract class Jobs {
  constructor(protected readonly doc: Document) {}

  protected settings(outputPath: string, opts: { async?: boolean; returnInline?: boolean } = {}): RunJobSettings {
    return {
      $typeName: "kiapi.common.types.RunJobSettings",
      document: this.doc.specifier,
      outputPath,
      async: opts.async ?? false,
      returnInline: opts.returnInline ?? false,
    };
  }
}

export class BoardJobs extends Jobs {
  export3D(outputPath: string, args: Args<typeof RunBoardJobExport3DSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExport3D(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExport3D", r, opts));
  }
  exportRender(outputPath: string, args: Args<typeof RunBoardJobExportRenderSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportRender(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportRender", r, opts));
  }
  exportSvg(outputPath: string, args: Args<typeof RunBoardJobExportSvgSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportSvg(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportSvg", r, opts));
  }
  exportDxf(outputPath: string, args: Args<typeof RunBoardJobExportDxfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportDxf(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportDxf", r, opts));
  }
  exportPdf(outputPath: string, args: Args<typeof RunBoardJobExportPdfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportPdf(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportPdf", r, opts));
  }
  exportPs(outputPath: string, args: Args<typeof RunBoardJobExportPsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportPs(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportPs", r, opts));
  }
  exportGerbers(outputPath: string, args: Args<typeof RunBoardJobExportGerbersSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportGerbers(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportGerbers", r, opts));
  }
  exportDrill(outputPath: string, args: Args<typeof RunBoardJobExportDrillSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportDrill(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportDrill", r, opts));
  }
  exportPosition(outputPath: string, args: Args<typeof RunBoardJobExportPositionSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportPosition(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportPosition", r, opts));
  }
  exportGencad(outputPath: string, args: Args<typeof RunBoardJobExportGencadSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportGencad(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportGencad", r, opts));
  }
  exportIpc2581(outputPath: string, args: Args<typeof RunBoardJobExportIpc2581Schema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportIpc2581(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportIpc2581", r, opts));
  }
  exportIpcD356(outputPath: string, args: Args<typeof RunBoardJobExportIpcD356Schema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportIpcD356(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportIpcD356", r, opts));
  }
  exportOdb(outputPath: string, args: Args<typeof RunBoardJobExportODBSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportODB(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportODB", r, opts));
  }
  exportStats(outputPath: string, args: Args<typeof RunBoardJobExportStatsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runBoardJobExportStats(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunBoardJobExportStats", r, opts));
  }
}

export class SchematicJobs extends Jobs {
  exportSvg(outputPath: string, args: Args<typeof RunSchematicJobExportSvgSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportSvg(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportSvg", r, opts));
  }
  exportDxf(outputPath: string, args: Args<typeof RunSchematicJobExportDxfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportDxf(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportDxf", r, opts));
  }
  exportPdf(outputPath: string, args: Args<typeof RunSchematicJobExportPdfSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportPdf(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportPdf", r, opts));
  }
  exportPs(outputPath: string, args: Args<typeof RunSchematicJobExportPsSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportPs(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportPs", r, opts));
  }
  exportNetlist(outputPath: string, args: Args<typeof RunSchematicJobExportNetlistSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportNetlist(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportNetlist", r, opts));
  }
  exportBom(outputPath: string, args: Args<typeof RunSchematicJobExportBOMSchema> = {}, opts?: JobOptions): Promise<JobResult> {
    return cmd.runSchematicJobExportBOM(this.doc.client, { ...args, jobSettings: this.settings(outputPath) }).then((r) => toResult("RunSchematicJobExportBOM", r, opts));
  }
}
