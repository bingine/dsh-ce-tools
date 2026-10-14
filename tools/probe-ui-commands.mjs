/**
 * 查 `ui-commands` 是否也在 web-app 的 composition 里、id 是什么。
 *
 * 背景：`@deepseek-ai/dsh-client-ui-permission-presets` 的 dsh.client.inject
 * 依赖 7 个包，其中包括 `@deepseek-ai/dsh-client-ui-commands`。
 * 若 ui-commands 没被启用，permission-presets 必然激活失败。
 */
import fs from "node:fs";

const ASAR = "C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";

function readAsarHeader(file) {
	const fd = fs.openSync(file, "r");
	const head = Buffer.alloc(16);
	fs.readSync(fd, head, 0, 16, 0);
	const jsonLen = head.readUInt32LE(12);
	const jsonBuf = Buffer.alloc(jsonLen);
	fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
	return {
		header: JSON.parse(jsonBuf.toString("utf8")),
		dataOffset: 16 + jsonLen + ((4 - ((16 + jsonLen) % 4)) % 4),
		fd
	};
}

function collectFiles(node, current = "", out = []) {
	for (const [name, child] of Object.entries(node.files ?? {})) {
		const p = current === "" ? name : `${current}/${name}`;
		if (child.files !== undefined) collectFiles(child, p, out);
		else out.push({ path: p, size: child.size ?? 0, offset: Number(child.offset ?? 0) });
	}
	return out;
}

const { header, dataOffset, fd } = readAsarHeader(ASAR);
try {
	const all = collectFiles(header);
	for (const f of all.filter((x) => /patch\.ya?ml$/i.test(x.path))) {
		const buf = Buffer.alloc(Math.min(f.size, 300_000));
		fs.readSync(fd, buf, 0, buf.length, dataOffset + f.offset);
		const text = buf.toString("utf8");
		if (!/ui-commands|dsh-commands/.test(text)) continue;
		console.log(`\n########## ${f.path} ##########`);
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			if (!/ui-commands|dsh-commands/.test(lines[i])) continue;
			let head = i;
			for (let j = i; j >= 0 && j > i - 8; j -= 1) {
				if (/^\s*- /.test(lines[j])) { head = j; break; }
			}
			console.log(`  --- 行 ${i + 1} ---`);
			for (let j = head; j <= i; j += 1) console.log(`      ${lines[j].trimEnd()}`);
		}
	}
} finally {
	fs.closeSync(fd);
}
