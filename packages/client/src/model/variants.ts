/** Design variants (`variant_commands.proto`), addressed through a board or schematic document. */
import type { DesignVariant } from "@fp-pcb/proto";
import * as cmd from "../commands";
import type { Document } from "./document";

export class Variants {
  constructor(private readonly doc: Document) {}

  async list(): Promise<DesignVariant[]> {
    const res = await cmd.getVariants(this.doc.client, { document: this.doc.specifier });
    return res.variants;
  }

  async names(): Promise<string[]> {
    return (await this.list()).map((v) => v.name);
  }

  async add(name: string, description?: string): Promise<void> {
    await cmd.addVariant(this.doc.client, { document: this.doc.specifier, name, description });
  }

  async delete(name: string): Promise<void> {
    await cmd.deleteVariant(this.doc.client, { document: this.doc.specifier, name });
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await cmd.renameVariant(this.doc.client, { document: this.doc.specifier, oldName, newName });
  }

  async copy(oldName: string, newName: string, newDescription?: string): Promise<void> {
    await cmd.copyVariant(this.doc.client, { document: this.doc.specifier, oldName, newName, newDescription });
  }

  async setDescription(name: string, description: string): Promise<void> {
    await cmd.setVariantDescription(this.doc.client, { document: this.doc.specifier, name, description });
  }

  /** The active variant name, or undefined for the base design. */
  async current(): Promise<string | undefined> {
    const res = await cmd.getCurrentVariant(this.doc.client, { document: this.doc.specifier });
    return res.name || undefined;
  }

  /** Activates `name`; `undefined` switches back to the base design. */
  async setCurrent(name: string | undefined): Promise<void> {
    await cmd.setCurrentVariant(this.doc.client, { document: this.doc.specifier, name });
  }
}
