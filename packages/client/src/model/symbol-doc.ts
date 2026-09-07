/**
 * `SymbolDocument` — a library symbol open headless (`OpenDocument(DOCTYPE_SYMBOL, "Lib:Name")`,
 * KiCad >= web-api e118ed3f81). Items are the symbol's children (pins, shapes, text, text boxes,
 * fields); `libSymbol()` returns the library definition itself as a `LibSymbol` (`KOT_LIB_SYMBOL`). Commits apply to the in-memory symbol; `save()` writes it back to the library.
 */
import { KiCadObjectType, type LibraryIdentifier } from "@fp-pcb/proto";
import { DocumentSync } from "../store/document-sync";
import type { ItemStore } from "../store/item-store";
import { Document, type DocumentKind } from "./document";
import { LibSymbol, SYMBOL_ITEM_TYPES, SchematicPin } from "./items";

export class SymbolDocument extends Document {
  readonly kind: DocumentKind = "symbol";
  readonly itemTypes = SYMBOL_ITEM_TYPES;
  private sync: DocumentSync | undefined;

  get libraryId(): LibraryIdentifier | undefined {
    return this.specifier.identifier.case === "libId" ? this.specifier.identifier.value : undefined;
  }

  /** `Lib:Name` */
  get libId(): string {
    const id = this.libraryId;
    return id ? `${id.libraryNickname}:${id.entryName}` : "";
  }

  get store(): ItemStore {
    this.sync ??= new DocumentSync(this);
    return this.sync.store;
  }

  get documentSync(): DocumentSync {
    this.sync ??= new DocumentSync(this);
    return this.sync;
  }

  /** The library definition (units, pins, graphics). */
  async libSymbol(): Promise<LibSymbol | undefined> {
    const items = await this.getItems(KiCadObjectType.KOT_LIB_SYMBOL);
    return items.find((i): i is LibSymbol => i instanceof LibSymbol);
  }

  async getPins(): Promise<SchematicPin[]> {
    return (await this.getItems(KiCadObjectType.KOT_SCH_PIN)).filter((i): i is SchematicPin => i instanceof SchematicPin);
  }
}
