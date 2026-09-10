import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const validSessionId = (id) => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

export function createOrderStore(directory) {
    const locks = new Map();
    const pathFor = (id) => {
        if (!validSessionId(id)) throw new Error('Invalid order identifier');
        return join(directory, `${id}.json`);
    };
    return {
        async read(id) {
            if (!validSessionId(id)) return null;
            try { return JSON.parse(await readFile(pathFor(id), 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async save(order) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const target = pathFor(order.id);
            const temporary = `${target}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(order, null, 2), { mode: 0o600, flag: 'wx' });
                await rename(temporary, target);
            } finally {
                await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
            }
        },
        async lock(id, action) {
            const previous = locks.get(id) || Promise.resolve();
            const work = previous.catch(() => {}).then(action);
            locks.set(id, work);
            try { return await work; }
            finally { if (locks.get(id) === work) locks.delete(id); }
        }
    };
}
