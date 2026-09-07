/**
 * `Libraries` — `library_commands.proto` (KiCad >= 11.0): the symbol / footprint / design-block
 * library tables, the entries of one library, and reading, writing and deleting library items.
 *
 * The commands are served only while a project is open (the tables are project-scoped) and each
 * one names the library type it addresses, so that the same nickname may exist in more than one
 * table; the handler for another type answers `AS_UNHANDLED`. `kicad.libraries` takes the type as
 * its first argument; `kicad.libraries.footprints` / `.symbols` / `.designBlocks` are views that
 * have it bound already.
 *
 * Footprint wizards (`ListWizards` / `RunWizard`) are served by the footprint library handler and
 * live here too: `wizards()` describes them and their parameters, `runWizard()` generates a
 * footprint that can be handed straight to `save()`.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  FootprintSchema,
  LibraryIdentifierSchema,
  LibraryTableRowSchema,
  LibraryType,
  LibraryTableScope,
  SchematicSymbolSchema,
  WizardGenerationStatus,
  WizardParameterListSchema,
  unpackAnyAs,
  type LibraryEntry,
  type LibraryIdentifier,
  type LibraryTableRow,
  type WizardInfo,
  type WizardParameter,
} from "@fp-pcb/proto";
import * as cmd from "../commands";
import { toEntries, type EntryMapLike } from "./entries";
import type { KiCadClient } from "../client";
import type { KiCad } from "./kicad";
import { LibFootprint, LibSymbol } from "./items";

/** The three library kinds KiCad keeps tables for. */
export type LibraryKind = "symbol" | "footprint" | "designBlock";

/** Which table a row lives in: KiCad's global table, or the open project's. */
export type TableScope = "global" | "project";

/** A library item as the API exchanges it: a footprint definition or a library symbol. */
export type LibraryItem = LibFootprint | LibSymbol;

export interface LibraryIdLike {
  nickname: string;
  name: string;
}

/** Anything that names a library entry: `"Nick:Name"`, `{nickname, name}`, or the proto message. */
export type LibIdLike = string | LibraryIdLike | LibraryIdentifier;

export interface CreateLibraryOptions {
  type: LibraryKind;
  nickname: string;
  /**
   * The URI as written into the table (`${KIPRJMOD}` and friends are kept). Empty creates a
   * KiCad-format library named after the nickname next to the project (project scope) or in the
   * user's documents folder (global scope).
   */
  uri?: string;
  scope?: TableScope;
  description?: string;
}

/** A table row to add: `nickname` is required, the rest of `LibraryTableRow` is optional. */
export type TableRowInput = MessageInitShape<typeof LibraryTableRowSchema> & { nickname: string };

/** `RunWizard` result: the generated footprint, ready for `save()`. */
export interface WizardResult {
  status: WizardGenerationStatus;
  ok: boolean;
  /** The generated content when `ok` and the wizard produced a footprint. */
  footprint?: LibFootprint;
  errorMessage: string;
}

/**
 * Parameter values for `runWizard`, keyed by `WizardParameter.identifier`. A `Map`, a plain
 * object or an array of `[identifier, value]` pairs; anything else throws.
 */
export type WizardParams = EntryMapLike<number | string | boolean>;

const TYPES: Record<LibraryKind, LibraryType> = {
  symbol: LibraryType.LT_SYMBOL,
  footprint: LibraryType.LT_FOOTPRINT,
  designBlock: LibraryType.LT_DESIGN_BLOCK,
};

const SCOPES: Record<TableScope, LibraryTableScope> = {
  global: LibraryTableScope.LTS_GLOBAL,
  project: LibraryTableScope.LTS_PROJECT,
};

export function libraryType(kind: LibraryKind): LibraryType {
  return TYPES[kind];
}

export function tableScope(scope: TableScope | undefined): LibraryTableScope {
  return scope ? SCOPES[scope] : LibraryTableScope.LTS_UNKNOWN;
}

/** Builds a `LibraryIdentifier` from `"Nick:Name"`, `{nickname, name}` or the message itself. */
export function toLibraryId(id: LibIdLike): LibraryIdentifier {
  if (typeof id === "string") {
    const i = id.indexOf(":");
    return create(LibraryIdentifierSchema, {
      libraryNickname: i < 0 ? id : id.slice(0, i),
      entryName: i < 0 ? "" : id.slice(i + 1),
    });
  }
  if ("$typeName" in id) return id;
  return create(LibraryIdentifierSchema, { libraryNickname: id.nickname, entryName: id.name });
}

/** `nickname:name` for a `LibraryIdentifier`. */
export function libIdString(id: LibraryIdentifier | undefined): string {
  return id ? `${id.libraryNickname}:${id.entryName}` : "";
}

export class Libraries {
  /** Cached `ListWizards` result; wizards do not change while KiCad runs. */
  private wizardList: WizardInfo[] | undefined;

  constructor(readonly kicad: KiCad) {}

  get client(): KiCadClient {
    return this.kicad.client;
  }

  /** A view with `type` bound, so `get`/`save`/`delete` take just the library id. */
  of(type: LibraryKind): LibraryView {
    return new LibraryView(this, type);
  }

  get footprints(): LibraryView {
    return this.of("footprint");
  }

  get symbols(): LibraryView {
    return this.of("symbol");
  }

  get designBlocks(): LibraryView {
    return this.of("designBlock");
  }

  /** `GetLibraryTables`: the rows of the global and project tables (global first) for one type. */
  async tables(type: LibraryKind, scope?: TableScope): Promise<LibraryTableRow[]> {
    const res = await cmd.getLibraryTables(this.client, { type: libraryType(type), scope: tableScope(scope) });
    return res.rows;
  }

  /** Nicknames of the tables of `type`, in table order. */
  async nicknames(type: LibraryKind, scope?: TableScope): Promise<string[]> {
    return (await this.tables(type, scope)).map((r) => r.nickname);
  }

  /**
   * `ListLibraryEntries`: every entry of one library, with a footprint or symbol summary.
   * `filter` is a case-insensitive substring matched against name, description and keywords.
   * The library is loaded on demand, so the first call for a large library can take a while.
   */
  async entries(type: LibraryKind, nickname: string, filter = ""): Promise<LibraryEntry[]> {
    const res = await cmd.listLibraryEntries(this.client, { type: libraryType(type), nickname, filter });
    return res.entries;
  }

  /** `GetLibraryItem`: the library definition, wrapped (`LibFootprint` or `LibSymbol`). */
  async get(type: LibraryKind, id: LibIdLike): Promise<LibraryItem | undefined> {
    const res = await cmd.getLibraryItem(this.client, { type: libraryType(type), id: toLibraryId(id) });
    const item = res.item?.item;
    if (item?.case === "footprint") return new LibFootprint(item.value);
    if (item?.case === "symbol") return new LibSymbol(item.value);
    return undefined;
  }

  /**
   * `SaveLibraryItem`: writes `item` into the library named by `id`. The item's own id is ignored;
   * an empty `entryName` in `id` keeps the item's name. Without `overwrite` an existing entry of
   * the same name is an error. Returns the id the item was written under.
   */
  async save(
    type: LibraryKind,
    id: LibIdLike,
    item: LibraryItem | MessageInitShape<typeof FootprintSchema> | MessageInitShape<typeof SchematicSymbolSchema>,
    opts: { overwrite?: boolean } = {},
  ): Promise<LibraryIdentifier> {
    const value =
      item instanceof LibFootprint
        ? { case: "footprint" as const, value: item.proto }
        : item instanceof LibSymbol
          ? { case: "symbol" as const, value: item.proto }
          : type === "symbol"
            ? { case: "symbol" as const, value: create(SchematicSymbolSchema, item as MessageInitShape<typeof SchematicSymbolSchema>) }
            : { case: "footprint" as const, value: create(FootprintSchema, item as MessageInitShape<typeof FootprintSchema>) };
    const res = await cmd.saveLibraryItem(this.client, {
      type: libraryType(type),
      id: toLibraryId(id),
      item: { item: value },
      overwrite: opts.overwrite ?? false,
    });
    return res.id ?? toLibraryId(id);
  }

  /** `DeleteLibraryItem` from a writable library. */
  async delete(type: LibraryKind, id: LibIdLike): Promise<void> {
    await cmd.deleteLibraryItem(this.client, { type: libraryType(type), id: toLibraryId(id) });
  }

  /**
   * `CreateLibrary`: creates an empty library on disk and adds a row for it to the table.
   * Publishes `ProjectChanged{PCK_LIBRARY_TABLES}`.
   */
  async createLibrary(opts: CreateLibraryOptions): Promise<LibraryTableRow> {
    return cmd.createLibrary(this.client, {
      type: libraryType(opts.type),
      nickname: opts.nickname,
      uri: opts.uri ?? "",
      scope: tableScope(opts.scope ?? "project"),
      description: opts.description ?? "",
    });
  }

  /**
   * `AddLibraryTableRow`: adds (or, with `replace`, replaces) a row and saves the table. The
   * library files are not created — use `createLibrary()` for that. The row's `scope`, `ok` and
   * `error` are ignored; an empty plugin `type` defaults to `"KiCad"`.
   */
  async addTableRow(type: LibraryKind, scope: TableScope, row: TableRowInput, replace = false): Promise<LibraryTableRow> {
    return cmd.addLibraryTableRow(this.client, {
      type: libraryType(type),
      scope: tableScope(scope),
      row: create(LibraryTableRowSchema, row),
      replace,
    });
  }

  /** `RemoveLibraryTableRow`: drops the row and saves the table; the library files stay. */
  async removeTableRow(type: LibraryKind, scope: TableScope, nickname: string): Promise<void> {
    await cmd.removeLibraryTableRow(this.client, { type: libraryType(type), scope: tableScope(scope), nickname });
  }

  // --- footprint wizards -------------------------------------------------------------------------

  /** `ListWizards`: the footprint wizards this KiCad instance offers, with their parameters. */
  async wizards(refresh = false): Promise<WizardInfo[]> {
    if (refresh || !this.wizardList) this.wizardList = (await cmd.listWizards(this.client, {})).wizards;
    return this.wizardList;
  }

  async wizard(identifier: string): Promise<WizardInfo | undefined> {
    return (await this.wizards()).find((w) => w.meta?.identifier === identifier);
  }

  /**
   * `RunWizard`: runs a footprint wizard. `params` are plain values keyed by
   * `WizardParameter.identifier`; they are typed against the wizard's declared parameters
   * (distances are nanometres, angles degrees, enums the choice index or its identifier), and
   * parameters left out keep their defaults. The generated footprint can be passed to `save()`.
   */
  async runWizard(identifier: string, params: WizardParams = {}): Promise<WizardResult> {
    const info = await this.wizard(identifier);
    const parameters: WizardParameter[] = [];
    for (const [key, value] of toEntries(params, `runWizard(${identifier}, params)`)) {
      const decl = info?.parameters.find((p) => p.identifier === key);
      if (!decl) throw new Error(`wizard ${identifier} has no parameter "${key}"`);
      parameters.push(withValue(decl, value));
    }
    const res = await cmd.runWizard(this.client, {
      identifier,
      parameters: create(WizardParameterListSchema, { parameters }),
    });
    const ok = res.status === WizardGenerationStatus.WGS_OK;
    let footprint: LibFootprint | undefined;
    if (ok && res.content) {
      const fp = unpackAnyAs(res.content, FootprintSchema);
      if (fp) footprint = new LibFootprint(fp);
    }
    return { status: res.status, ok, footprint, errorMessage: res.errorMessage };
  }
}

/** `Libraries` with the library type bound (`kicad.libraries.footprints`). */
export class LibraryView {
  constructor(
    readonly libraries: Libraries,
    readonly type: LibraryKind,
  ) {}

  tables(scope?: TableScope): Promise<LibraryTableRow[]> {
    return this.libraries.tables(this.type, scope);
  }

  nicknames(scope?: TableScope): Promise<string[]> {
    return this.libraries.nicknames(this.type, scope);
  }

  entries(nickname: string, filter = ""): Promise<LibraryEntry[]> {
    return this.libraries.entries(this.type, nickname, filter);
  }

  get(id: LibIdLike): Promise<LibraryItem | undefined> {
    return this.libraries.get(this.type, id);
  }

  save(
    id: LibIdLike,
    item: LibraryItem | MessageInitShape<typeof FootprintSchema> | MessageInitShape<typeof SchematicSymbolSchema>,
    opts?: { overwrite?: boolean },
  ): Promise<LibraryIdentifier> {
    return this.libraries.save(this.type, id, item, opts);
  }

  delete(id: LibIdLike): Promise<void> {
    return this.libraries.delete(this.type, id);
  }

  createLibrary(opts: Omit<CreateLibraryOptions, "type">): Promise<LibraryTableRow> {
    return this.libraries.createLibrary({ ...opts, type: this.type });
  }

  addTableRow(scope: TableScope, row: TableRowInput, replace = false): Promise<LibraryTableRow> {
    return this.libraries.addTableRow(this.type, scope, row, replace);
  }

  removeTableRow(scope: TableScope, nickname: string): Promise<void> {
    return this.libraries.removeTableRow(this.type, scope, nickname);
  }
}

/** Copies `decl` and sets its value oneof from a plain JS value, respecting the declared type. */
function withValue(decl: WizardParameter, value: number | string | boolean): WizardParameter {
  const p: WizardParameter = { ...decl };
  const v = decl.value;
  switch (v.case) {
    case "int":
      p.value = { case: "int", value: { ...v.value, value: Math.round(Number(value)) } };
      return p;
    case "real":
      p.value = { case: "real", value: { ...v.value, value: Number(value) } };
      return p;
    case "bool":
      p.value = { case: "bool", value: { ...v.value, value: Boolean(value) } };
      return p;
    case "string":
      p.value = { case: "string", value: { ...v.value, value: String(value) } };
      return p;
    case "enum": {
      const idx = typeof value === "number" ? value : v.value.choices.findIndex((c) => c.identifier === value || c.label === value);
      if (idx < 0) throw new Error(`wizard parameter "${decl.identifier}" has no choice "${String(value)}"`);
      p.value = { case: "enum", value: { ...v.value, value: idx } };
      return p;
    }
    default:
      throw new Error(`wizard parameter "${decl.identifier}" has no value type`);
  }
}
