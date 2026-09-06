/** `FootprintDocument` — a footprint open in the footprint editor (by library id). */
import { DocumentType, type LibraryIdentifier } from "@kicad-web/proto";
import * as cmd from "../commands";
import { DocumentSync } from "../store/document-sync";
import type { ItemStore } from "../store/item-store";
import { Document, type DocumentKind } from "./document";
import { FOOTPRINT_ITEM_TYPES } from "./items";

export class FootprintDocument extends Document {
  readonly kind: DocumentKind = "footprint";
  readonly itemTypes = FOOTPRINT_ITEM_TYPES;
  private sync: DocumentSync | undefined;

  get libraryId(): LibraryIdentifier | undefined {
    return this.specifier.identifier.case === "libId" ? this.specifier.identifier.value : undefined;
  }

  get store(): ItemStore {
    this.sync ??= new DocumentSync(this);
    return this.sync.store;
  }

  get documentSync(): DocumentSync {
    this.sync ??= new DocumentSync(this);
    return this.sync;
  }

  /** `OpenLibraryItem`: (re)opens this footprint in the GUI footprint editor. */
  async openInEditor(): Promise<void> {
    await cmd.openLibraryItem(this.client, { type: DocumentType.DOCTYPE_FOOTPRINT, identifier: this.libraryId });
  }
}
