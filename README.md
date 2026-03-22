# st-live-css-editor（实时CSS编辑器）

SillyTavern 第三方扩展：提供一个浮动窗口用于编辑 CSS，并在输入后 500ms 防抖实时注入到页面，实现“所见即所得”的样式预览；点击保存后会持久化，刷新/重启仍然生效。

## 功能
- 浮动窗口（可拖拽、可调整大小）
- 实时预览：编辑区输入后自动注入（默认 500ms 防抖）
- 保存：持久化 CSS 到扩展设置，并立即应用
- 导出：将当前配置导出为 JSON 文件（`st-live-css-editor.json`）
- 导入：从 JSON 文件导入配置（会覆盖当前已保存版本，并立即应用）
- 回滚：恢复到上次“已保存”的 CSS
- 清空：清空编辑区并移除预览（不保存）
- 启用开关：一键启用/禁用注入

## 安装
1. 将整个文件夹 [`st-live-css-editor/`](st-live-css-editor/README.md:1) 放到 SillyTavern 目录：
   - `SillyTavern/public/scripts/extensions/third-party/st-live-css-editor/`
2. 重启 SillyTavern
3. 在扩展菜单（Extensions）中找到「实时CSS编辑器」

## 使用
1. 打开扩展菜单 → 点击「实时CSS编辑器」打开浮窗
2. 在文本框输入 CSS（例如：
   ```css
   body { filter: hue-rotate(30deg); }
   ```
   ）
3. 等待约 500ms，样式会被注入并立即预览
4. 点击“保存”将当前 CSS 写入设置（刷新后仍生效）

### 导入/导出（JSON）
- 导出：点击“导出”下载 `st-live-css-editor.json`
- 导入：点击“导入”选择 `.json` 文件；导入后会覆盖当前**已保存**配置，并立即应用

JSON 支持两种结构（方便手工编辑/兼容其它工具）：
1. 完整结构（导出得到的格式）：
   ```json
   {
     "schema": 1,
     "module": "st-live-css-editor",
     "exportedAt": "2026-01-01T00:00:00.000Z",
     "settings": {
       "enabled": true,
       "cssText": "body { }",
       "debounceMs": 500,
       "ui": { "x": 40, "y": 80, "w": 520, "h": 420, "collapsed": false }
     }
   }
   ```
2. 仅 settings：
   ```json
   {
     "enabled": true,
     "cssText": "body { }",
     "debounceMs": 500,
     "ui": { "x": 40, "y": 80, "w": 520, "h": 420 }
   }
   ```

### 草稿说明
- 未点击“保存”的内容仅用于预览，不会持久化；刷新页面会回到上次已保存版本。

## 文件说明
- 清单：[`st-live-css-editor/manifest.json`](st-live-css-editor/manifest.json:1)
- 入口脚本：[`st-live-css-editor/index.js`](st-live-css-editor/index.js:1)
- 窗口样式：[`st-live-css-editor/style.css`](st-live-css-editor/style.css:1)

## 手工测试清单
- 在扩展菜单能看到入口并打开窗口
- 输入 CSS 后 500ms 内页面样式发生变化
- 点击保存后刷新页面仍然生效
- 点击“导出”下载 JSON，内容包含 cssText / enabled / ui 等字段
- 修改 JSON 后点击“导入”，配置被覆盖并立即生效
- 导入一个坏 JSON：状态栏提示“JSON 解析错误”
- 关闭“启用”后样式立即移除，再启用后恢复
- 拖拽/调整大小后刷新，窗口位置尺寸能恢复

## 许可证
MIT
