# 本地 AI 对话系统

一个可在本机运行的网页对话应用。浏览器负责聊天界面，Node.js 后端保存会话并调用 DeepSeek Responses API。适合需要本地管理对话历史、查看 token 用量和整理长对话上下文的用户。

## 功能

- 新建和切换对话；会话保存在本机，刷新页面或重启服务后仍可恢复。
- 查看每轮及整段对话的输入、输出、缓存命中 token 和缓存命中率。缓存由模型 API 处理，本项目展示 API 返回的统计，不缓存模型回复。
- 查看当前上下文用量估算，并为每段对话设置自动压缩阈值和目标容量。
- 到达阈值后自动生成摘要，也可手动生成、编辑或撤销摘要版本。页面仍可查看原始消息。
- 按日期记录请求结果、耗时和用量，便于排查问题；日志不记录消息正文。
- 可选配置系统提示词。API 密钥仅由后端读取，不传给浏览器。

目前支持**本机文本对话**。MCP 工具、图片附件、流式回复和手机访问尚未接入。服务仅监听 `127.0.0.1`，没有公网访问所需的身份验证。

## 快速开始

需要 Node.js 22.21+ 或 24.5+、可用的 DeepSeek API 密钥。项目没有第三方运行依赖。

1. 在项目目录中复制配置模板：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 打开本机 `.env`，填写 `DEEPSEEK_API_KEY`。`DEEPSEEK_MODEL` 默认是 `deepseek-flash`；使用其他受支持的模型时可修改。

3. 启动服务：

   ```powershell
   npm start
   ```

4. 在本机浏览器打开 `http://127.0.0.1:4370`。如果修改了 `PORT`，使用对应端口。

`.env`、聊天数据和日志均已加入 Git 忽略列表。请勿将真实密钥提交到仓库。

## 配置

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥，必填 |
| `DEEPSEEK_MODEL` | 模型名称，默认 `deepseek-flash` |
| `DEEPSEEK_CONTEXT_WINDOW_TOKENS` | 可选，手动指定模型上下文容量；未配置的模型可能显示为未知 |
| `SYSTEM_PROMPT` | 可选，普通对话使用的系统提示词 |
| `PORT` | 本机服务端口，默认 `4370` |

修改 `.env` 后需重启服务。上下文圆环展示的是发送内容的估算值，并非 API 的实际计费 token；摘要生成会另发模型请求，也会消耗 token。

## 数据与测试

会话存放于 `data/conversations/`，请求日志存放于 `logs/`。这两个目录只在本机使用，不随 Git 同步。需要保留历史时，请自行备份会话目录。

```powershell
npm test
```

测试使用模拟响应，不调用 DeepSeek API，也不会产生 API 费用。

## 代码结构

```text
public/                       网页界面与用量统计
server/index.mjs               HTTP 服务与接口
server/conversations.mjs       本机会话存储
server/compaction.mjs          摘要、版本与上下文整理
server/providers/deepseek.mjs  DeepSeek API 适配器
server/logger.mjs              请求日志
```

浏览器通过本机 HTTP 接口发送消息；后端读取会话、调用模型并保存回复。当前模型适配器只实现 DeepSeek，增加其他模型需要实现回复和摘要两种请求。
