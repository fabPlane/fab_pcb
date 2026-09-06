/** `Project` — the open KiCad project: its board / schematic, net classes and text variables. */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DocumentType,
  MapMergeMode,
  NetClassSchema,
  TextVariablesSchema,
  type DocumentSpecifier,
  type NetClass,
  type ProjectFile,
  type ProjectInfoResponse,
} from "@kicad-web/proto";
import * as cmd from "../commands";
import type { Board } from "./board";
import type { KiCad } from "./kicad";
import type { Schematic } from "./schematic";
import { toRecord, type EntryMapLike } from "./entries";

export class Project {
  constructor(
    readonly kicad: KiCad,
    /** A `DOCTYPE_PROJECT` specifier (from `OpenDocument`) or the `project` of another document. */
    readonly specifier: DocumentSpecifier,
  ) {}

  get client() {
    return this.kicad.client;
  }

  /** Project name without extension. */
  get name(): string {
    return this.specifier.project?.name ?? "";
  }

  /** Project directory. */
  get path(): string {
    return this.specifier.project?.path ?? "";
  }

  private filePath(ext: string): string {
    const dir = this.path.endsWith("/") ? this.path : `${this.path}/`;
    return `${dir}${this.name}${ext}`;
  }

  /** Opens the project's board (`<dir>/<name>.kicad_pcb` unless `path` is given). */
  openBoard(path: string = this.filePath(".kicad_pcb")): Promise<Board> {
    return this.kicad.openBoard(path);
  }

  /** Opens the project's root schematic (`<dir>/<name>.kicad_sch` unless `path` is given). */
  openSchematic(path: string = this.filePath(".kicad_sch")): Promise<Schematic> {
    return this.kicad.openSchematic(path);
  }

  /** Boards already open for this project (`GetOpenDocuments`). */
  async openBoards(): Promise<Board[]> {
    const docs = await this.kicad.openDocuments(DocumentType.DOCTYPE_PCB);
    return docs.map((d) => this.kicad.boardFrom(d));
  }

  async openSchematics(): Promise<Schematic[]> {
    const docs = await this.kicad.openDocuments(DocumentType.DOCTYPE_SCHEMATIC);
    return docs.map((d) => this.kicad.schematicFrom(d));
  }

  /** Creates and opens a new (empty) board for this project (`NewDocument`; CLI api-server only). */
  newBoard(path?: string): Promise<Board> {
    return this.kicad.newDocument(DocumentType.DOCTYPE_PCB, path);
  }

  /** Creates and opens a new (empty) root schematic for this project (`NewDocument`; CLI api-server only). */
  newSchematic(path?: string): Promise<Schematic> {
    return this.kicad.newDocument(DocumentType.DOCTYPE_SCHEMATIC, path);
  }

  /** `GetProjectInfo`: the `.kicad_pro` path and every file in the project directory, classified. */
  info(): Promise<ProjectInfoResponse> {
    return this.kicad.projectInfo();
  }

  /** Files of the project by kind (`GetProjectInfo`), e.g. every schematic with its open state. */
  async files(): Promise<ProjectFile[]> {
    return (await this.info()).files;
  }

  async netClasses(): Promise<NetClass[]> {
    return (await cmd.getNetClasses(this.client, {})).netClasses;
  }

  /** Replace (default) or merge net classes. */
  async setNetClasses(netClasses: readonly MessageInitShape<typeof NetClassSchema>[], mergeMode: MapMergeMode = MapMergeMode.MMM_REPLACE): Promise<void> {
    await cmd.setNetClasses(this.client, { netClasses: netClasses.map((n) => create(NetClassSchema, n)), mergeMode });
  }

  async textVariables(): Promise<Record<string, string>> {
    const res = await cmd.getTextVariables(this.client, { document: this.specifier });
    return { ...res.variables };
  }

  /**
   * `SetTextVariables`. Accepts a `Map`, a plain object or an array of `[name, value]` pairs.
   *
   * The shape matters here beyond a silent no-op: protobuf-es stores an unrecognised init value
   * in the map field as-is and serialises zero pairs, so a `Map` passed with
   * `MapMergeMode.MMM_REPLACE` used to wipe every text variable in the project.
   */
  async setTextVariables(variables: EntryMapLike<string>, mergeMode: MapMergeMode = MapMergeMode.MMM_MERGE): Promise<void> {
    const map = toRecord(variables, "setTextVariables(variables)");
    await cmd.setTextVariables(this.client, { document: this.specifier, variables: create(TextVariablesSchema, { variables: map }), mergeMode });
  }

  async expandTextVariables(text: readonly string[], expandEnvVars = false): Promise<string[]> {
    return (await cmd.expandTextVariables(this.client, { document: this.specifier, text: [...text], expandEnvVars })).text;
  }

  /** Closes the project and its documents. */
  async close(): Promise<void> {
    await cmd.closeDocument(this.client, { document: this.specifier });
  }

  toString(): string {
    return `Project(${this.name})`;
  }
}
