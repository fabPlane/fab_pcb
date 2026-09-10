/** Rebuild the generated part of a project's root schematic from the compile netlist. */
import { clone, create } from "@bufbuild/protobuf";
import {
  GlobalLabelSchema,
  NoConnectMarkerSchema,
  packAny,
  SchematicSymbolSchema,
  SchematicFieldSchema,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicPinSchema,
  SchematicLineType,
  SchematicSymbolBodyStyleSchema,
  SchematicSymbolInstanceSchema,
  SchematicSymbolOrientation,
  SchematicSymbolTransformSchema,
  SchematicSymbolUnitSchema,
  TextSchema,
  unpackAnyAs,
  type SchematicField as SchematicFieldProto,
} from "@fp-pcb/proto";
import {
  KiCad,
  GlobalLabel,
  mm,
  mil,
  NoConnect,
  SchematicLine,
  SchematicSymbol,
  toDistance,
  toVector2,
  vec2,
  type Item,
  type LibSymbol,
  type Schematic,
  type Vec2,
} from "@fp-pcb/client";
import type { Diagnostic, Netlist } from "./types";

export const GENERATED_SCHEMATIC_PROPERTY = "fp-pcb.generated";
const GENERATED_SCHEMATIC_VALUE = "circuit.netlist.json";
const SCHEMATIC_GRID_MM = 1.27;

export interface GeneratedSchematic {
  items: Item[];
  diagnostics: Diagnostic[];
  symbolsCreated: number;
  wiresCreated: number;
  labelsCreated: number;
  noConnectsCreated: number;
}

export interface GenerateSchematicResult extends GeneratedSchematic {
  schematic: Schematic;
}

function generated<T extends Item>(item: T): T {
  item.setCustomProperty(GENERATED_SCHEMATIC_PROPERTY, GENERATED_SCHEMATIC_VALUE);
  return item;
}

function generatedLabelField(position: Vec2): SchematicFieldProto {
  return create(SchematicFieldSchema, {
    name: GENERATED_SCHEMATIC_PROPERTY,
    visible: false,
    allowAutoPlace: true,
    text: create(TextSchema, { text: GENERATED_SCHEMATIC_VALUE, position: toVector2(position) }),
  });
}

function isGeneratedLabel(item: Item): item is GlobalLabel {
  return (
    item instanceof GlobalLabel &&
    item.fields.some((field) => field.name === GENERATED_SCHEMATIC_PROPERTY && field.text === GENERATED_SCHEMATIC_VALUE)
  );
}

function positionKey(position: Vec2): string {
  return `${position.x}:${position.y}`;
}

function referenceClass(reference: string): string {
  return reference.match(/^[^0-9?]+/)?.[0] ?? reference.replace(/\?+$/, "");
}

function positionedField(source: SchematicFieldProto | undefined, name: string, value: string, origin: Vec2): SchematicFieldProto {
  const field = source ? clone(SchematicFieldSchema, source) : create(SchematicFieldSchema, { name, visible: false, allowAutoPlace: true });
  field.name = name;
  field.text ??= create(TextSchema);
  field.text.text = value;
  const relative = vec2(field.text.position);
  field.text.position = toVector2({ x: origin.x + relative.x, y: origin.y + relative.y });
  return field;
}

/**
 * A symbol-library document exposes pin positions in library-local coordinates, while a placed
 * SchematicSymbolInstance carries its selected pins in absolute sheet coordinates. Convert the
 * cloned library definition before sending it to KiCad; shapes and fields remain library-local.
 */
function placedDefinition(source: LibSymbol, origin: Vec2, pins: Map<string, Vec2>, reference: string) {
  const definition = clone(SchematicSymbolSchema, source.proto);

  for (const child of definition.items) {
    if (!child.item) continue;
    const pin = unpackAnyAs(child.item, SchematicPinSchema);
    if (!pin) continue;
    const relative = vec2(pin.position);
    const absolute = { x: origin.x + relative.x, y: origin.y + relative.y };
    // Library pin KIIDs belong to the library definition. Each placed instance must receive
    // independent pin identities from KiCad rather than aliasing pins across repeated symbols.
    pin.id = undefined;
    pin.position = toVector2(absolute);
    child.item = packAny(SchematicPinSchema, pin);
    if (pin.number) pins.set(`${reference}:${pin.number}`, absolute);
  }

  return definition;
}

/** Pure geometry builder, separated from KiCad I/O for focused regression tests. */
export function buildGeneratedSchematic(netlist: Netlist, definitions: ReadonlyMap<string, LibSymbol>): GeneratedSchematic {
  const items: Item[] = [];
  const diagnostics: Diagnostic[] = [];
  const pins = new Map<string, Vec2>();
  let symbolsCreated = 0;
  let wiresCreated = 0;
  let labelsCreated = 0;
  let noConnectsCreated = 0;

  for (const [index, component] of netlist.components.entries()) {
    if (!component.libSource) {
      diagnostics.push({
        severity: "error",
        stage: "schematic",
        code: "missing_symbol",
        message: `${component.ref}: libSource is required to draw this component in the generated schematic.`,
      });
      continue;
    }
    const libId = `${component.libSource.lib}:${component.libSource.part}`;
    const definition = definitions.get(libId);
    if (!definition) {
      diagnostics.push({
        severity: "error",
        stage: "schematic",
        code: "unknown_symbol",
        message: `${component.ref}: symbol ${libId} could not be loaded; the board compile is unchanged.`,
      });
      continue;
    }
    const symbolReference = definition.proto.referenceField?.text?.text ?? "";
    const expectedReferenceClass = referenceClass(symbolReference);
    const actualReferenceClass = referenceClass(component.ref);
    if (expectedReferenceClass && actualReferenceClass !== expectedReferenceClass) {
      diagnostics.push({
        severity: "error",
        stage: "schematic",
        code: "symbol_reference_mismatch",
        message: `${component.ref}: symbol ${libId} declares reference class ${expectedReferenceClass}, not ${actualReferenceClass}; choose a symbol whose electrical function matches the component.`,
      });
    }

    // Keep generated symbols and their labelled stubs on KiCad's default 50 mil grid.
    const position = {
      x: mm(24 * SCHEMATIC_GRID_MM + (index % 4) * 28 * SCHEMATIC_GRID_MM),
      y: mm(20 * SCHEMATIC_GRID_MM + Math.floor(index / 4) * 24 * SCHEMATIC_GRID_MM),
    };
    const proto = create(SchematicSymbolInstanceSchema, {
      position: toVector2(position),
      transform: create(SchematicSymbolTransformSchema, { orientation: SchematicSymbolOrientation.SSO_0 }),
      definition: placedDefinition(definition, position, pins, component.ref),
      libId: definition.proto.id,
      referenceField: positionedField(definition.proto.referenceField, "Reference", component.ref, position),
      valueField: positionedField(definition.proto.valueField, "Value", component.value, position),
      footprintField: positionedField(definition.proto.footprintField, "Footprint", component.footprint, position),
      datasheetField: positionedField(
        definition.proto.datasheetField,
        "Datasheet",
        component.fields?.Datasheet ?? component.fields?.datasheet ?? "",
        position,
      ),
      descriptionField: positionedField(
        definition.proto.descriptionField,
        "Description",
        component.fields?.Description ?? component.fields?.description ?? "",
        position,
      ),
      unit: create(SchematicSymbolUnitSchema, { unit: 1 }),
      bodyStyle: create(SchematicSymbolBodyStyleSchema, { style: 1 }),
      showPinNames: true,
      showPinNumbers: true,
      fieldsAutoplaced: false,
      userFields: Object.entries(component.fields ?? {})
        .filter(([name]) => !["Datasheet", "datasheet"].includes(name))
        .map(([name, value]) => positionedField(undefined, name, value, position)),
    });
    const symbol = generated(new SchematicSymbol(proto));
    items.push(symbol);
    symbolsCreated++;
  }

  // A labelled stub at every connected pin produces correct KiCad connectivity without routing
  // long wires through unrelated symbols. Global labels keep the root schematic's net names
  // identical to the board updater's names instead of path-qualifying them as `/NAME`.
  const connectedPositions = new Set<string>();
  for (const net of netlist.nets) {
    for (const node of net.nodes) {
      const start = pins.get(`${node.ref}:${node.pin}`);
      if (!start) {
        diagnostics.push({
          severity: "error",
          stage: "schematic",
          code: "unknown_symbol_pin",
          message: `${node.ref} pin ${node.pin} (${net.name}) could not be drawn because the symbol or pin is unavailable.`,
        });
        continue;
      }
      connectedPositions.add(positionKey(start));
      const end = { x: start.x - mm(5.08), y: start.y };
      const wire = generated(
        new SchematicLine(create(SchematicLineSchema, { start: toVector2(start), end: toVector2(end), type: SchematicLineType.SLT_WIRE })),
      );
      const label = generated(
        new GlobalLabel(
          create(GlobalLabelSchema, {
            position: toVector2(end),
            text: create(TextSchema, { text: net.name, position: toVector2(end) }),
            spinStyle: SchematicLabelSpinStyle.SLSS_LEFT,
            // KiCad currently serialises custom properties on global labels but does not return
            // them through GetItems after reopen. A hidden field is the durable ownership marker.
            fields: [generatedLabelField(end)],
          }),
        ),
      );
      items.push(wire, label);
      wiresCreated++;
      labelsCreated++;
    }
  }

  const noConnectPositions = new Set<string>();
  for (const declaration of netlist.noConnects ?? []) {
    const position = pins.get(`${declaration.ref}:${declaration.pin}`);
    if (!position) {
      diagnostics.push({
        severity: "error",
        stage: "schematic",
        code: "unknown_no_connect_pin",
        message: `${declaration.ref} pin ${declaration.pin} could not be marked no-connect because the symbol or pin is unavailable.`,
      });
      continue;
    }
    const key = positionKey(position);
    if (connectedPositions.has(key)) {
      diagnostics.push({
        severity: "error",
        stage: "schematic",
        code: "no_connect_on_connected_position",
        message: `${declaration.ref} pin ${declaration.pin} shares a symbol position with a connected pin and cannot be marked no-connect.`,
      });
      continue;
    }
    // Stacked symbol pins (common on USB connectors) share one electrical position and need one X.
    if (noConnectPositions.has(key)) continue;
    noConnectPositions.add(key);
    items.push(
      generated(
        new NoConnect(
          create(NoConnectMarkerSchema, {
            position: toVector2(position),
            size: toDistance(mil(48)),
          }),
        ),
      ),
    );
    noConnectsCreated++;
  }

  return { items, diagnostics, symbolsCreated, wiresCreated, labelsCreated, noConnectsCreated };
}

/** Load referenced symbols, replace only our marked root-sheet items, and leave manual work intact. */
export async function generateSchematic(kicad: KiCad, netlist: Netlist): Promise<GenerateSchematicResult> {
  const board = await kicad.currentBoard();
  const schematic = (await kicad.currentSchematic()) ?? (board ? await kicad.projectFrom(board.specifier).openSchematic() : undefined);
  if (!schematic) throw new Error("the project has no schematic document");
  const root = await schematic.rootSheet();
  const definitions = new Map<string, LibSymbol>();
  for (const component of netlist.components) {
    if (!component.libSource) continue;
    const libId = `${component.libSource.lib}:${component.libSource.part}`;
    if (definitions.has(libId)) continue;
    const definition = await kicad
      .openSymbol(libId)
      .then((document) => document.libSymbol())
      .catch(() => undefined);
    if (definition) definitions.set(libId, definition);
  }
  const generatedItems = buildGeneratedSchematic(netlist, definitions);
  const existingItems = await root.getAllItems();
  const generatedWireEnds = new Set(
    existingItems
      .filter(
        (item): item is SchematicLine =>
          item instanceof SchematicLine && item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === GENERATED_SCHEMATIC_VALUE,
      )
      .map((wire) => positionKey(wire.end)),
  );
  const oldIds = existingItems
    .filter(
      (item) =>
        item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === GENERATED_SCHEMATIC_VALUE ||
        isGeneratedLabel(item) ||
        // One-time migration for schematics written before global labels had a durable field.
        // Such labels can only be recovered through their still-marked generated wire endpoint.
        (item instanceof GlobalLabel && generatedWireEnds.has(positionKey(item.position))),
    )
    .map((item) => item.id)
    .filter(Boolean);
  if (oldIds.length || generatedItems.items.length) {
    await root.commit("fp-pcb: rebuild generated schematic", async (tx) => {
      if (oldIds.length) await tx.delete(oldIds);
      if (generatedItems.items.length) await tx.create(generatedItems.items);
    });
  }
  return { schematic, ...generatedItems };
}
