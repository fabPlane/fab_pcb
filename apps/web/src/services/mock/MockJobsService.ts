import type { JobDefinition, JobRun, JobsService } from '../types';

const LAYER_CHOICES = ['BL_F_Cu', 'BL_In1_Cu', 'BL_In2_Cu', 'BL_B_Cu', 'BL_F_SilkS', 'BL_B_SilkS', 'BL_F_Mask', 'BL_B_Mask', 'BL_F_Paste', 'BL_B_Paste', 'BL_Edge_Cuts'];

export const JOB_DEFINITIONS: JobDefinition[] = [
  {
    id: 'board.gerbers',
    title: 'Gerbers',
    description: 'Plot copper, mask, paste, silkscreen and edge layers as RS-274X.',
    document: 'board',
    command: 'RunBoardJobExportGerbers',
    options: [
      { key: 'layers', label: 'Layers', type: 'layers', default: LAYER_CHOICES, choices: LAYER_CHOICES.map((l) => ({ value: l, label: l.replace('BL_', '').replace('_', '.') })) },
      { key: 'useProtelExtensions', label: 'Use Protel filename extensions', type: 'boolean', default: false },
      { key: 'includeNetlistAttributes', label: 'Include netlist attributes (X2)', type: 'boolean', default: true },
      { key: 'subtractSoldermask', label: 'Subtract soldermask from silkscreen', type: 'boolean', default: true },
      { key: 'precision', label: 'Coordinate format', type: 'select', default: '4.6', choices: [{ value: '4.5', label: '4.5 (unit mm)' }, { value: '4.6', label: '4.6 (unit mm)' }] },
    ],
  },
  {
    id: 'board.drill',
    title: 'Drill files',
    description: 'Excellon drill files, PTH and NPTH separated, plus a drill map.',
    document: 'board',
    command: 'RunBoardJobExportDrill',
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'excellon', choices: [{ value: 'excellon', label: 'Excellon' }, { value: 'gerber', label: 'Gerber X2' }] },
      { key: 'mirrorY', label: 'Mirror Y axis', type: 'boolean', default: false },
      { key: 'minimalHeader', label: 'Minimal header', type: 'boolean', default: false },
      { key: 'generateMap', label: 'Generate drill map (PDF)', type: 'boolean', default: true },
      { key: 'origin', label: 'Drill origin', type: 'select', default: 'absolute', choices: [{ value: 'absolute', label: 'Absolute' }, { value: 'plot', label: 'Drill/place file origin' }] },
    ],
  },
  {
    id: 'board.position',
    title: 'Component placement (pick and place)',
    description: 'CSV placement file with reference, value, footprint, position and rotation.',
    document: 'board',
    command: 'RunBoardJobExportPos',
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'csv', choices: [{ value: 'csv', label: 'CSV' }, { value: 'ascii', label: 'ASCII' }, { value: 'gerber', label: 'Gerber X3' }] },
      { key: 'units', label: 'Units', type: 'select', default: 'mm', choices: [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }] },
      { key: 'side', label: 'Side', type: 'select', default: 'both', choices: [{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }, { value: 'both', label: 'Both' }] },
      { key: 'smdOnly', label: 'SMD footprints only', type: 'boolean', default: true },
      { key: 'excludeDnp', label: 'Exclude DNP', type: 'boolean', default: true },
    ],
  },
  {
    id: 'board.step',
    title: 'STEP / GLB 3D model',
    description: 'Export the board with 3D models for mechanical CAD (STEP) or the browser 3D viewer (GLB).',
    document: 'board',
    command: 'RunBoardJobExport3D',
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'step', choices: [{ value: 'step', label: 'STEP' }, { value: 'glb', label: 'GLB (binary glTF)' }, { value: 'xao', label: 'XAO' }] },
      { key: 'includeTracks', label: 'Include tracks and vias', type: 'boolean', default: false },
      { key: 'includeZones', label: 'Include zones', type: 'boolean', default: false },
      { key: 'substituteModels', label: 'Substitute STEP for VRML models', type: 'boolean', default: true },
      { key: 'boardOnly', label: 'Board body only (no components)', type: 'boolean', default: false },
    ],
  },
  {
    id: 'board.svg',
    title: 'SVG plot',
    description: 'Vector plot of the selected layers; also used for renderer pixel-diff tests.',
    document: 'board',
    command: 'RunBoardJobExportSvg',
    options: [
      { key: 'layers', label: 'Layers', type: 'layers', default: ['BL_F_Cu', 'BL_F_SilkS', 'BL_Edge_Cuts'], choices: LAYER_CHOICES.map((l) => ({ value: l, label: l.replace('BL_', '').replace('_', '.') })) },
      { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
      { key: 'mirror', label: 'Mirror', type: 'boolean', default: false },
      { key: 'pageSize', label: 'Page', type: 'select', default: 'board', choices: [{ value: 'board', label: 'Board area' }, { value: 'page', label: 'Full page' }] },
    ],
  },
  {
    id: 'board.ipc2581',
    title: 'IPC-2581',
    description: 'Single-file fabrication and assembly data package.',
    document: 'board',
    command: 'RunBoardJobExportIpc2581',
    options: [
      { key: 'version', label: 'IPC-2581 revision', type: 'select', default: 'C', choices: [{ value: 'B', label: 'Revision B' }, { value: 'C', label: 'Revision C' }] },
      { key: 'compress', label: 'Compress output', type: 'boolean', default: true },
      { key: 'bomMpn', label: 'BOM MPN field', type: 'string', default: 'MPN' },
    ],
  },
  {
    id: 'schematic.pdf',
    title: 'Schematic PDF',
    description: 'All sheets as a single PDF with hyperlinks between sheets.',
    document: 'schematic',
    command: 'RunSchematicJobExportPdf',
    options: [
      { key: 'blackAndWhite', label: 'Black and white', type: 'boolean', default: false },
      { key: 'excludeDrawingSheet', label: 'Exclude drawing sheet (frame)', type: 'boolean', default: false },
      { key: 'theme', label: 'Colour theme', type: 'select', default: 'kicad_classic', choices: [{ value: 'kicad_classic', label: 'KiCad Classic' }, { value: 'kicad_default', label: 'KiCad Default' }] },
    ],
  },
  {
    id: 'schematic.netlist',
    title: 'Netlist',
    description: 'Netlist in KiCad, SPICE or Cadstar format.',
    document: 'schematic',
    command: 'RunSchematicJobExportNetlist',
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'kicadsexpr', choices: [{ value: 'kicadsexpr', label: 'KiCad s-expression' }, { value: 'kicadxml', label: 'KiCad XML' }, { value: 'spice', label: 'SPICE' }, { value: 'cadstar', label: 'Cadstar' }, { value: 'orcadpcb2', label: 'OrCAD PCB2' }] },
    ],
  },
  {
    id: 'schematic.bom',
    title: 'Bill of materials',
    description: 'CSV BOM grouped by value and footprint.',
    document: 'schematic',
    command: 'RunSchematicJobExportBom',
    options: [
      { key: 'fields', label: 'Fields', type: 'string', default: 'Reference,Value,Footprint,${QUANTITY},${DNP}' },
      { key: 'groupBy', label: 'Group by', type: 'string', default: 'Value,Footprint' },
      { key: 'excludeDnp', label: 'Exclude DNP', type: 'boolean', default: true },
      { key: 'delimiter', label: 'Field delimiter', type: 'select', default: ',', choices: [{ value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' }] },
    ],
  },
];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockJobsService implements JobsService {
  private runList: JobRun[] = [];
  private subs = new Set<() => void>();
  private seq = 1;

  constructor(private readonly stepMs = 120) {}

  jobs(): JobDefinition[] {
    return JOB_DEFINITIONS;
  }

  runs(): JobRun[] {
    return this.runList;
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    this.runList = [...this.runList];
    for (const cb of this.subs) cb();
  }

  clearFinished(): void {
    this.runList = this.runList.filter((r) => r.state === 'running' || r.state === 'queued');
    this.emit();
  }

  async run(jobId: string, options: Record<string, unknown>): Promise<JobRun> {
    const def = JOB_DEFINITIONS.find((j) => j.id === jobId);
    if (!def) throw new Error(`Unknown job ${jobId}`);
    const run: JobRun = {
      id: `run-${this.seq++}`,
      jobId,
      title: def.title,
      startedAt: Date.now(),
      state: 'queued',
      progress: 0,
      log: [`${def.command} ${JSON.stringify(options)}`],
      outputs: [],
    };
    this.runList = [run, ...this.runList];
    this.emit();

    await delay(this.stepMs);
    run.state = 'running';
    const steps = this.stepsFor(def, options);
    for (let i = 0; i < steps.length; i++) {
      run.log.push(steps[i]!);
      run.progress = (i + 1) / (steps.length + 1);
      this.emit();
      await delay(this.stepMs);
    }
    if (options.__fail === true) {
      run.state = 'failed';
      run.error = 'AS_BAD_REQUEST: output directory is not writable';
      run.finishedAt = Date.now();
      run.log.push(`error: ${run.error}`);
      this.emit();
      return run;
    }
    run.outputs = this.outputsFor(def, options);
    run.log.push(`done: ${run.outputs.length} file(s), ${(run.outputs.reduce((a, o) => a + o.bytes, 0) / 1024).toFixed(1)} KiB`);
    run.progress = 1;
    run.state = 'done';
    run.finishedAt = Date.now();
    this.emit();
    return run;
  }

  private stepsFor(def: JobDefinition, options: Record<string, unknown>): string[] {
    switch (def.id) {
      case 'board.gerbers': {
        const layers = (options.layers as string[] | undefined) ?? [];
        return ['Loading board…', ...layers.map((l) => `Plotting ${l.replace('BL_', '')}`), 'Writing job file (.gbrjob)'];
      }
      case 'board.drill':
        return ['Loading board…', 'Collecting holes: 7 PTH, 0 NPTH', 'Writing PTH drill file', 'Writing NPTH drill file', ...(options.generateMap ? ['Rendering drill map'] : [])];
      case 'board.step':
        return ['Loading board…', 'Building board solid', 'Loading 4 footprint models', 'Fusing 3D models', `Writing ${String(options.format).toUpperCase()}`];
      case 'schematic.pdf':
        return ['Loading schematic…', 'Plotting sheet 1/2: Root', 'Plotting sheet 2/2: Power supply', 'Writing PDF'];
      case 'schematic.bom':
        return ['Loading schematic…', 'Collecting 5 symbols (2 power symbols excluded)', 'Grouping by Value, Footprint', 'Writing CSV'];
      default:
        return ['Loading document…', 'Running job', 'Writing output'];
    }
  }

  private outputsFor(def: JobDefinition, options: Record<string, unknown>): JobRun['outputs'] {
    const base = '/tmp/kicad-web/jobs/api_kitchen_sink';
    switch (def.id) {
      case 'board.gerbers':
        return [
          ...((options.layers as string[] | undefined) ?? []).map((l) => ({ name: `api_kitchen_sink-${l.replace('BL_', '').replace('_', '_')}.gbr`, path: `${base}/gerbers`, bytes: 4_000 + Math.floor(Math.random() * 20_000), mime: 'application/vnd.gerber' })),
          { name: 'api_kitchen_sink-job.gbrjob', path: `${base}/gerbers`, bytes: 1_902, mime: 'application/json' },
        ];
      case 'board.drill':
        return [
          { name: 'api_kitchen_sink-PTH.drl', path: `${base}/drill`, bytes: 812, mime: 'text/plain' },
          { name: 'api_kitchen_sink-NPTH.drl', path: `${base}/drill`, bytes: 244, mime: 'text/plain' },
          ...(options.generateMap ? [{ name: 'api_kitchen_sink-drl_map.pdf', path: `${base}/drill`, bytes: 22_190, mime: 'application/pdf' }] : []),
        ];
      case 'board.position':
        return [{ name: `api_kitchen_sink-${String(options.side)}-pos.${options.format === 'ascii' ? 'pos' : 'csv'}`, path: base, bytes: 610, mime: 'text/csv' }];
      case 'board.step':
        return [{ name: `api_kitchen_sink.${String(options.format)}`, path: base, bytes: options.format === 'glb' ? 291_004 : 1_402_310, mime: options.format === 'glb' ? 'model/gltf-binary' : 'model/step' }];
      case 'board.svg':
        return [{ name: 'api_kitchen_sink.svg', path: base, bytes: 74_220, mime: 'image/svg+xml' }];
      case 'board.ipc2581':
        return [{ name: `api_kitchen_sink.xml${options.compress ? '.zip' : ''}`, path: base, bytes: options.compress ? 88_310 : 640_002, mime: 'application/xml' }];
      case 'schematic.pdf':
        return [{ name: 'api_kitchen_sink.pdf', path: base, bytes: 156_800, mime: 'application/pdf' }];
      case 'schematic.netlist':
        return [{ name: `api_kitchen_sink.${options.format === 'spice' ? 'cir' : options.format === 'kicadxml' ? 'xml' : 'net'}`, path: base, bytes: 9_120, mime: 'text/plain' }];
      case 'schematic.bom':
        return [{ name: 'api_kitchen_sink-bom.csv', path: base, bytes: 402, mime: 'text/csv' }];
      default:
        return [];
    }
  }
}
