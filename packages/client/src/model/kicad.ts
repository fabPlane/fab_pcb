/**
 * `KiCad` — the root of the object model (mirrors kipy's `KiCad`): version, paths, opening
 * projects and documents, text tessellation.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ApiStatusCode,
  DocumentSpecifierSchema,
  DocumentType,
  FrameType,
  PathType,
  TextBoxSchema,
  TextSchema,
  type CompoundShape,
  type CrossProbeStatus,
  type DocumentSpecifier,
  type GetJobStatusResponse,
  type GetServerInfoResponse,
  type KiCadVersion,
  type ProjectInfoResponse,
} from "@kicad-web/proto";
import { KiCadClient, type Capabilities, type KiCadClientOptions } from "../client";
import { KiCadApiError } from "../errors";
import * as cmd from "../commands";
import { box2, type Box } from "../units";
import type { Transport } from "../transport/types";
import { Board } from "./board";
import { FootprintDocument } from "./footprint-doc";
import { Job } from "./jobs";
import { Project } from "./project";
import { Schematic } from "./schematic";
import { SymbolDocument } from "./symbol-doc";

export interface TextShapes {
  /** The request's text/text box, echoed back. */
  index: number;
  shapes: CompoundShape | undefined;
}

export class KiCad {
  constructor(readonly client: KiCadClient) {}

  /** Connects a transport and waits for the server to be ready. */
  static async connect(transport: Transport, opts: KiCadClientOptions): Promise<KiCad> {
    return new KiCad(await KiCadClient.connect(transport, opts));
  }

  version(): Promise<KiCadVersion> {
    return this.client.version();
  }

  async versionString(): Promise<string> {
    const v = await this.version();
    return v.fullVersion || `${v.major}.${v.minor}.${v.patch}`;
  }

  ping(): Promise<void> {
    return this.client.ping();
  }

  capabilities(): Promise<Capabilities> {
    return this.client.capabilities();
  }

  /** Absolute path of a KiCad binary (`kicad-cli`, `pcbnew`, ...). */
  async binaryPath(binaryName: string): Promise<string> {
    return (await cmd.getKiCadBinaryPath(this.client, { binaryName })).path;
  }

  /** Well-known paths (user plugins, templates, stock symbols, ...). */
  async paths(): Promise<Map<PathType, string>> {
    const res = await cmd.getPaths(this.client, {});
    return new Map(res.paths.map((p) => [p.type, p.path]));
  }

  async pluginSettingsPath(identifier: string): Promise<string> {
    return (await cmd.getPluginSettingsPath(this.client, { identifier })).response;
  }

  /**
   * Request socket URL, events (pub/sub) socket URL and token of the server (`GetServerInfo`,
   * KiCad >= web-api e8cd61a2f2). `eventsSocketUrl` is empty when the server does not publish
   * events; `undefined` when the server predates the command.
   */
  async serverInfo(): Promise<GetServerInfoResponse | undefined> {
    try {
      return await cmd.getServerInfo(this.client, {});
    } catch (e) {
      if (KiCadApiError.is(e) && e.isUnsupported) return undefined;
      throw e;
    }
  }

  /** Handle for a job by id (`RunJobResponse.job_id` / `JobProgress.job_id`): `status()`, `wait()`. */
  job(jobId: string): Job {
    return new Job(this.client, jobId);
  }

  /** `GetJobStatus` (KiCad >= 11.0); `AS_BAD_REQUEST` for an id KiCad no longer knows. */
  jobStatus(jobId: string): Promise<GetJobStatusResponse> {
    return this.job(jobId).status();
  }

  // --- documents -------------------------------------------------------------------------------------

  /** Raw `OpenDocument`; returns the specifier KiCad assigned. */
  async openDocument(type: DocumentType, path: string): Promise<DocumentSpecifier> {
    const res = await cmd.openDocument(this.client, { type, path });
    return res.document ?? create(DocumentSpecifierSchema, { type });
  }

  /** Opens a `.kicad_pro` (just the project; open the board/schematic through the returned handle). */
  async openProject(path: string): Promise<Project> {
    return new Project(this, await this.openDocument(DocumentType.DOCTYPE_PROJECT, path));
  }

  /** Opens a `.kicad_pcb` (its project is loaded alongside). */
  async openBoard(path: string): Promise<Board> {
    return new Board(this, await this.openDocument(DocumentType.DOCTYPE_PCB, path));
  }

  async openSchematic(path: string): Promise<Schematic> {
    return new Schematic(this, await this.openDocument(DocumentType.DOCTYPE_SCHEMATIC, path));
  }

  /** Opens a footprint by library id (`nickname:name`) in the footprint editor context. */
  async openFootprint(libId: string): Promise<FootprintDocument> {
    return new FootprintDocument(this, await this.openDocument(DocumentType.DOCTYPE_FOOTPRINT, libId));
  }

  /** Opens a library symbol by id (`nickname:name`) as a headless symbol document (KiCad >= e118ed3f81). */
  async openSymbol(libId: string): Promise<SymbolDocument> {
    return new SymbolDocument(this, await this.openDocument(DocumentType.DOCTYPE_SYMBOL, libId));
  }

  /**
   * `NewProject`: creates `<path>.kicad_pro` (or `<dir>/<dir name>.kicad_pro`) on disk, plus a stub
   * root schematic and board unless `skipStubDocuments`, and opens it when `open` (default true).
   * CLI api-server only (the GUI answers AS_UNIMPLEMENTED).
   */
  async newProject(path: string, opts: { templatePath?: string; open?: boolean; skipStubDocuments?: boolean } = {}): Promise<Project> {
    const res = await cmd.newProject(this.client, {
      path,
      templatePath: opts.templatePath,
      open: opts.open ?? true,
      skipStubDocuments: opts.skipStubDocuments ?? false,
    });
    return new Project(this, res.document ?? create(DocumentSpecifierSchema, { type: DocumentType.DOCTYPE_PROJECT }));
  }

  /**
   * `NewDocument`: writes an empty schematic or board for the open project and opens it. `path`
   * defaults to `<project>.kicad_sch` / `.kicad_pcb`; relative paths are inside the project directory.
   */
  async newDocument(type: DocumentType.DOCTYPE_SCHEMATIC, path?: string): Promise<Schematic>;
  async newDocument(type: DocumentType.DOCTYPE_PCB, path?: string): Promise<Board>;
  async newDocument(type: DocumentType, path?: string): Promise<Board | Schematic>;
  async newDocument(type: DocumentType, path = ""): Promise<Board | Schematic> {
    const res = await cmd.newDocument(this.client, { type, path });
    const spec = res.document ?? create(DocumentSpecifierSchema, { type });
    return type === DocumentType.DOCTYPE_PCB ? new Board(this, spec) : new Schematic(this, spec);
  }

  /** `GetProjectInfo`: the open project and the files in its directory, classified. CLI api-server only. */
  async projectInfo(): Promise<ProjectInfoResponse> {
    return cmd.getProjectInfo(this.client, {});
  }

  /**
   * `GetOpenDocuments` of one type. KiCad answers `AS_UNHANDLED` instead of an empty list when no
   * editor of that kind exists (headless: nothing of the type is open); that is mapped to `[]`.
   */
  async openDocuments(type: DocumentType): Promise<DocumentSpecifier[]> {
    try {
      return (await cmd.getOpenDocuments(this.client, { type })).documents;
    } catch (e) {
      if (KiCadApiError.is(e, ApiStatusCode.AS_UNHANDLED)) return [];
      throw e;
    }
  }

  /** The board KiCad currently has open, if any (GUI: the PCB editor's board). */
  async currentBoard(): Promise<Board | undefined> {
    const d = (await this.openDocuments(DocumentType.DOCTYPE_PCB))[0];
    return d ? this.boardFrom(d) : undefined;
  }

  async currentSchematic(): Promise<Schematic | undefined> {
    const d = (await this.openDocuments(DocumentType.DOCTYPE_SCHEMATIC))[0];
    return d ? this.schematicFrom(d) : undefined;
  }

  boardFrom(specifier: DocumentSpecifier): Board {
    return new Board(this, specifier);
  }

  schematicFrom(specifier: DocumentSpecifier): Schematic {
    return new Schematic(this, specifier);
  }

  symbolFrom(specifier: DocumentSpecifier): SymbolDocument {
    return new SymbolDocument(this, specifier);
  }

  /** The symbol document currently open headless, if any. */
  async currentSymbol(): Promise<SymbolDocument | undefined> {
    const d = (await this.openDocuments(DocumentType.DOCTYPE_SYMBOL))[0];
    return d ? this.symbolFrom(d) : undefined;
  }

  projectFrom(specifier: DocumentSpecifier): Project {
    return new Project(this, create(DocumentSpecifierSchema, { type: DocumentType.DOCTYPE_PROJECT, project: specifier.project }));
  }

  async closeAllDocuments(force = false): Promise<void> {
    await cmd.closeAllDocuments(this.client, { force });
  }

  // --- text -----------------------------------------------------------------------------------------------

  /** Bounding box (nm) of a text as KiCad's font engine would render it. */
  async textExtents(text: MessageInitShape<typeof TextSchema>): Promise<Box> {
    return box2(await cmd.getTextExtents(this.client, { text: create(TextSchema, text) }));
  }

  /** Server-side tessellation of texts / text boxes into polygons (for the renderer). */
  async textAsShapes(items: readonly ({ text: MessageInitShape<typeof TextSchema> } | { textbox: MessageInitShape<typeof TextBoxSchema> })[]): Promise<TextShapes[]> {
    const res = await cmd.getTextAsShapes(this.client, {
      text: items.map((i) =>
        "text" in i
          ? { inner: { case: "text" as const, value: create(TextSchema, i.text) } }
          : { inner: { case: "textbox" as const, value: create(TextBoxSchema, i.textbox) } },
      ),
    });
    return res.textWithShapes.map((t, index) => ({ index, shapes: t.shapes }));
  }

  /** Registers this client as a cross-probe peer (`CrossProbeAnnounce`). */
  async crossProbeAnnounce(frameType: FrameType, socketPath: string, apiToken = ""): Promise<{ status: CrossProbeStatus; message: string }> {
    const res = await cmd.crossProbeAnnounce(this.client, { frameType, socketPath, apiToken });
    return { status: res.status, message: res.message };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
