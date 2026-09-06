// CommandService.record(): ops that already happened on the server (ParseAndCreateItemsFromString
// pastes) enter the history and undo / redo replay them through the backend.
import './setup';
import { describe, expect, test } from 'bun:test';
import { createMockServices } from '@/services';
import { mutatorFor } from '@/services/CommandService';
import type { StoredItem } from '@/contracts';

describe('CommandService.record', () => {
  test('recorded creates undo as deletes and redo as creates', async () => {
    const services = createMockServices();
    const store = services.documents.board()!;
    const item: StoredItem = { id: 'pasted-1', type: 'KOT_PCB_TRACE', proto: { id: { value: 'pasted-1' }, layer: 'BL_F_Cu' }, layer: 'BL_F_Cu' };
    mutatorFor(store).insert(item); // what DocumentSync does when KiCad reports the paste
    expect(store.get('pasted-1')).toBeDefined();
    expect(services.commands.canUndo()).toBe(false);

    services.commands.record(store, 'Paste 1 item (KiCad text)', [{ kind: 'create', item }], [{ kind: 'delete', item }]);
    expect(services.commands.canUndo()).toBe(true);
    expect(services.commands.history().undo[0]!.message).toBe('Paste 1 item (KiCad text)');

    const undone = await services.commands.undo();
    expect(undone?.message).toBe('Paste 1 item (KiCad text)');
    expect(store.get('pasted-1')).toBeUndefined();

    await services.commands.redo();
    expect(store.get('pasted-1')).toBeDefined();
  });
});
