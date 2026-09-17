# 个人工作看板

带账号系统的多视图工作看板：表格 / 看板（可拖拽）/ 甘特图，支持自定义所属板块与颜色。

## 启动

```bash
node server.js
```

然后访问 http://localhost:3210 （用 `PORT=8080 node server.js` 可换端口）。

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`，无需安装任何依赖）。

## 使用

- 首次打开先注册账号；每个账号的任务和板块互相隔离。
- 头部「板块管理」可新增/重命名/删除板块并选择颜色；删除板块时其中的任务会移入第一个板块。
- 数据保存在同目录的 `data.sqlite`，会话有效期 30 天。

## 更新迭代（不会丢数据的流程）

1. **代码进 git，数据不进**：`data.sqlite` 和 `backups/` 已在 `.gitignore` 里，更新只会替换 `server.js` / `index.html`。
2. **自动备份**：服务器每次启动、以及每 24 小时，都会把数据库一致性快照存到 `backups/`（保留最近 30 份）。回滚 = 停服 → 用备份文件替换 `data.sqlite` → 重启。
3. **改表结构走迁移**：不要手动改数据库。在 `server.js` 的 `MIGRATIONS` 数组里追加一条 `{ v: N, sql: '...' }`（N 递增），下次启动自动执行且只执行一次。
4. **先在开发库验证再上线**：

   ```bash
   cp data.sqlite /tmp/dev.sqlite          # 复制一份真实数据当试验田
   DB_PATH=/tmp/dev.sqlite PORT=3211 node server.js   # 开发实例
   # 浏览器打开 localhost:3211 验证无误后，再更新正式实例并重启
   ```

5. 部署到服务器时，更新命令就是：`git pull` → 重启进程。启动时会自动先备份再迁移。

## 文件

- `server.js` — 后端（HTTP + SQLite + 会话 + 备份 + 迁移）
- `index.html` — 前端（单文件，无构建）
- `data.sqlite` — 数据库（首次启动自动创建，已 gitignore）
- `backups/` — 自动备份目录（已 gitignore）
