import { mkdir,copyFile,readdir,lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join,dirname } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=join(root,'.cloudflare/public');
const files=['index.html','checkout.html','science.html','results.html','how-to-use.html','styles.css','checkout.css','site.js','checkout.js','admin.html','admin.css','admin.js','admin-demo.js'];
const logo='Skintroniks-20260903T124736Z-1-001/Skintroniks/SKINTRONICS_LOGO.png';
for (const asset of await readdir(join(root,'assets'))) if (/^[A-Za-z0-9_-]+\.(webp|png|jpe?g)$/.test(asset)) files.push(`assets/${asset}`);
files.push(logo);
for (const file of files) {
    if (!(await lstat(join(root,file))).isFile()) throw new Error(`Only regular public files can be packaged: ${file}`);
    await mkdir(dirname(join(output,file)),{recursive:true});
    await copyFile(join(root,file),join(output,file));
}
console.log(`Packaged ${files.length} public files for Cloudflare. Private records and configuration are excluded.`);
