// Local SQLite adapter for tests and the fixture preview. Production uses the real D1 binding.
import { DatabaseSync } from 'node:sqlite';
export function localD1(filename=':memory:') {
    const sqlite=new DatabaseSync(filename);
    sqlite.exec('PRAGMA foreign_keys=ON');
    function prepare(sql) {
        let args=[];
        const statement={
            bind(...values){args=values;return statement;},
            async first(column){const row=sqlite.prepare(sql).get(...args);return row?(column?row[column]:{...row}):null;},
            async all(){const rows=sqlite.prepare(sql).all(...args);return {results:rows.map((r)=>({...r})),success:true,meta:{changes:0}};},
            execute(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},
            async run(){return statement.execute();}
        };
        return statement;
    }
    return {prepare,async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map((s)=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},async exec(sql){sqlite.exec(sql);},close(){sqlite.close();}};
}
