/** Rebuild the generated part of a project's root schematic from the compile netlist. */
import { clone, create } from "@bufbuild/protobuf";
import {
  ErcErrorType,
  GlobalLabelSchema,
  NoConnectMarkerSchema,
  packAny,
  SchematicSymbolSchema,
  SchematicFieldSchema,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicPinOrientation,
  SchematicPinSchema,
  SchematicLineType,
  SchematicSymbolBodyStyleSchema,
  SchematicSymbolInstanceSchema,
  SchematicSymbolOrientation,
  SchematicSymbolTransformSchema,
  SchematicSymbolUnitSchema,
  TextSchema,
  unpackAnyAs,
  type ErcMarker,
  type SchematicField as SchematicFieldProto,
} from "@fp-pcb/proto";
import {
  KiCad,
  GlobalLabel,
  mm,
  mil,
  nm,
  NoConnect,
  SchematicLine,
  SchematicSymbol,
  toDistance,
  toVector2,
  vec2,
  type Item,
  LibSymbol,
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

interface PlacedPin {
  position: Vec2;
  orientation: SchematicPinOrientation;
}

const STUB_LENGTH = mm(4 * SCHEMATIC_GRID_MM);

/** Where a pin's labelled stub points: away from the symbol body. Unknown orientations keep the leftward fallback. */
function outward(orientation: SchematicPinOrientation): { direction: Vec2; spinStyle: SchematicLabelSpinStyle } {
  switch (orientation) {
    // Pin orientation is the direction the symbol body extends from the connection point,
    // so the labelled stub must extend in the opposite direction.
    case SchematicPinOrientation.SPO_LEFT:
      return { direction: { x: 1, y: 0 }, spinStyle: SchematicLabelSpinStyle.SLSS_RIGHT };
    case SchematicPinOrientation.SPO_UP:
      return { direction: { x: 0, y: 1 }, spinStyle: SchematicLabelSpinStyle.SLSS_BOTTOM };
    case SchematicPinOrientation.SPO_DOWN:
      return { direction: { x: 0, y: -1 }, spinStyle: SchematicLabelSpinStyle.SLSS_UP };
    case SchematicPinOrientation.SPO_RIGHT:
    case SchematicPinOrientation.SPO_UNKNOWN:
    default:
      return { direction: { x: -1, y: 0 }, spinStyle: SchematicLabelSpinStyle.SLSS_LEFT };
  }
}

function along(from: Vec2, direction: Vec2, distance: number): Vec2 {
  return { x: from.x + direction.x * distance, y: from.y + direction.y * distance };
}

function labelledStub(pin: PlacedPin): { end: Vec2; spinStyle: SchematicLabelSpinStyle } {
  const { direction, spinStyle } = outward(pin.orientation);
  return { end: along(pin.position, direction, STUB_LENGTH), spinStyle };
}

/** How far a symbol reaches from its origin in each direction (all values positive). */
interface Extent {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A generous global-label length: KiCad's default 1.27 mm text plus the label outline. */
function labelLength(text: string): number {
  return mm(SCHEMATIC_GRID_MM * (text.length + 2));
}

/**
 * The reach of a symbol's pins, body (approximated by the pin roots), labelled stubs and labels.
 * Outward stubs on the top and bottom edges point at the neighbouring grid rows, so spacing must
 * come from this reach or a stub can run into another symbol's stub and join two nets.
 */
function symbolExtent(definition: LibSymbol, reference: string, pinNets: ReadonlyMap<string, string>): Extent {
  const minimum = mm(2 * SCHEMATIC_GRID_MM);
  const extent: Extent = { left: minimum, right: minimum, top: minimum, bottom: minimum };
  const include = (point: Vec2) => {
    extent.left = Math.max(extent.left, -point.x);
    extent.right = Math.max(extent.right, point.x);
    extent.top = Math.max(extent.top, -point.y);
    extent.bottom = Math.max(extent.bottom, point.y);
  };
  for (const child of definition.proto.items) {
    const pin = child.item ? unpackAnyAs(child.item, SchematicPinSchema) : undefined;
    if (!pin) continue;
    const position = vec2(pin.position);
    const { direction } = outward(pin.orientation);
    include(position);
    include(along(position, direction, -nm(pin.length)));
    const net = pinNets.get(`${reference}:${pin.number}`);
    if (net !== undefined) include(along(position, direction, STUB_LENGTH + labelLength(net)));
  }
  return extent;
}

function snapUp(value: number): number {
  const grid = mm(SCHEMATIC_GRID_MM);
  return Math.ceil(value / grid) * grid;
}

const LAYOUT_COLUMNS = 4;

/**
 * Symbol origins on a four-column grid. Small symbols keep the historical 28 x 24 grid-unit pitch;
 * columns and rows grow when symbols with their stubs and labels would otherwise meet. Every
 * origin stays on the 50 mil grid so library pins do too.
 */
function layoutSymbols(extents: readonly (Extent | undefined)[]): Vec2[] {
  const gap = mm(2 * SCHEMATIC_GRID_MM);
  const margin = mm(8 * SCHEMATIC_GRID_MM);
  const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);
  const known = extents.filter((extent): extent is Extent => extent !== undefined);
  const pitchX = snapUp(Math.max(mm(28 * SCHEMATIC_GRID_MM), max(known.map((e) => e.right)) + max(known.map((e) => e.left)) + gap));
  const x0 = snapUp(Math.max(mm(24 * SCHEMATIC_GRID_MM), max(known.map((e) => e.left)) + margin));

  const rows = Math.ceil(extents.length / LAYOUT_COLUMNS);
  const row = (r: number) => extents.slice(r * LAYOUT_COLUMNS, (r + 1) * LAYOUT_COLUMNS).filter((e): e is Extent => e !== undefined);
  const rowY: number[] = [];
  for (let r = 0; r < rows; r++) {
    rowY.push(
      r === 0
        ? snapUp(Math.max(mm(20 * SCHEMATIC_GRID_MM), max(row(0).map((e) => e.top)) + margin))
        : rowY[r - 1]! +
            snapUp(Math.max(mm(24 * SCHEMATIC_GRID_MM), max(row(r - 1).map((e) => e.bottom)) + max(row(r).map((e) => e.top)) + gap)),
    );
  }
  return extents.map((_, index) => ({ x: x0 + (index % LAYOUT_COLUMNS) * pitchX, y: rowY[Math.floor(index / LAYOUT_COLUMNS)]! }));
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
 * A symbol definition's children, pins included, are in the symbol's local frame both in a
 * symbol-library document and in a placed SchematicSymbolInstance, so the cloned library
 * definition is sent as it is; only the pin map records absolute sheet positions (for wires,
 * labels and no-connects).
 */
function placedDefinition(source: LibSymbol, origin: Vec2, pins: Map<string, PlacedPin>, reference: string) {
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
    child.item = packAny(SchematicPinSchema, pin);
    if (pin.number) pins.set(`${reference}:${pin.number}`, { position: absolute, orientation: pin.orientation });
  }

  return definition;
}

/** Pure geometry builder, separated from KiCad I/O for focused regression tests. */
export function buildGeneratedSchematic(netlist: Netlist, definitions: ReadonlyMap<string, LibSymbol>): GeneratedSchematic {
  const items: Item[] = [];
  const diagnostics: Diagnostic[] = [];
  const pins = new Map<string, PlacedPin>();
  let symbolsCreated = 0;
  let wiresCreated = 0;
  let labelsCreated = 0;
  let noConnectsCreated = 0;

  const pinNets = new Map(netlist.nets.flatMap((net) => net.nodes.map((node) => [`${node.ref}:${node.pin}`, net.name] as const)));
  const positions = layoutSymbols(
    netlist.components.map((component) => {
      const definition = component.libSource && definitions.get(`${component.libSource.lib}:${component.libSource.part}`);
      return definition ? symbolExtent(definition, component.ref, pinNets) : undefined;
    }),
  );

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

    const position = positions[index]!;
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
      showPinNames: definition.proto.showPinNames,
      showPinNumbers: definition.proto.showPinNumbers,
      pinNameOffset: definition.proto.pinNameOffset,
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
      const pin = pins.get(`${node.ref}:${node.pin}`);
      if (!pin) {
        diagnostics.push({
          severity: "error",
          stage: "schematic",
          code: "unknown_symbol_pin",
          message: `${node.ref} pin ${node.pin} (${net.name}) could not be drawn because the symbol or pin is unavailable.`,
        });
        continue;
      }
      const start = pin.position;
      connectedPositions.add(positionKey(start));
      const { end, spinStyle } = labelledStub(pin);
      const wire = generated(
        new SchematicLine(create(SchematicLineSchema, { start: toVector2(start), end: toVector2(end), type: SchematicLineType.SLT_WIRE })),
      );
      const label = generated(
        new GlobalLabel(
          create(GlobalLabelSchema, {
            position: toVector2(end),
            text: create(TextSchema, { text: net.name, position: toVector2(end) }),
            spinStyle,
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
    const position = pins.get(`${declaration.ref}:${declaration.pin}`)?.position;
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
    // GetLibraryItem returns the effective definition, including inherited pins and graphics.
    // The symbol-editor document contains only its editable children.
    const definition = await kicad.libraries.symbols.get(libId).catch(() => undefined);
    if (definition instanceof LibSymbol) definitions.set(libId, definition);
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

/**
 * KiCad reports two net names on one connected item set as a driver-conflict warning, not an error.
 * Every generated label names a distinct netlist net, so a conflict between two of them is a short
 * drawn by the generator, whatever geometry caused it. Returns those markers' descriptions.
 */
export async function generatedNetMerges(schematic: Schematic, markers: readonly ErcMarker[]): Promise<string[]> {
  const conflicts = markers.filter((marker) => !marker.excluded && marker.errorType === ErcErrorType.ERCET_DRIVER_CONFLICT);
  if (!conflicts.length) return [];
  const labels = new Set((await (await schematic.rootSheet()).getAllItems()).filter(isGeneratedLabel).map((label) => label.id));
  return conflicts
    .filter((marker) => marker.items.length === 2 && marker.items.every((item) => labels.has(item.value)))
    .map((marker) => marker.description);
}
