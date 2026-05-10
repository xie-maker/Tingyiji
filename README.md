# 听译集

听译集是一个本地可运行的外文歌曲歌词译中工具。你粘贴外文歌词，填写歌名和歌手，选择翻译偏好和大模型接口后，它会把歌词翻译成中文，并保留原文换行做逐行对照。

## 启动

如果电脑可以直接运行 `node`：

```powershell
node server.js
```

如果系统里的 `node` 提示 Access denied，可以使用 Codex 自带的 Node：

```powershell
& "C:\Users\xie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
```

启动后打开：

```text
http://localhost:3000
```

## API 接口

页面右上角点“配置接口”，可以管理最多 5 个接口配置。每个配置都可以选择 OpenAI、DeepSeek、通义千问、Moonshot、智谱 GLM 或自定义 OpenAI-compatible API，并独立保存供应商、Base URL、模型和 API Key 保存状态。填写 Base URL、API Key 后，可以点“检索模型”读取当前配置可用模型。

配置说明：

- 配置名称固定为配置1到配置5。
- 点击“添加配置”会启用下一个空位，最多 5 个。
- 当前启用配置会显示在首页 API 摘要里，例如 `配置2 · DeepSeek / deepseek-chat`。
- 每个配置的“保存到本机浏览器”独立生效；未勾选时，刷新后不会恢复该配置的 API Key。

也可以复制 `.env.local.example` 为 `.env.local`，在本地后端配置密钥：

```env
OPENAI_API_KEY=sk-...
TRANSLATION_MODEL=gpt-5.4-mini
DEEPSEEK_API_KEY=
DASHSCOPE_API_KEY=
MOONSHOT_API_KEY=
ZHIPU_API_KEY=
CUSTOM_API_KEY=
CUSTOM_BASE_URL=
CUSTOM_MODEL=
PORT=3000
HOST=0.0.0.0
HISTORY_DIR=E:\codex.xm\歌词翻译网页\历史库
```

## 功能

- 支持全部外文歌曲歌词翻译成中文，默认自动识别源语言。
- 支持歌名、歌手、源语言和丰富翻译偏好。
- 翻译偏好默认收起，可细调用途、基础风格、忠实度、中文气质、情绪强度、节奏、押韵、行长、hook 一致性、俚语处理和自定义要求。
- 偏好会自动保存为下次默认，并随历史记录一起保存。
- 输入歌词会自动整理多余空格和异常换行。
- 输出译文固定使用空格和换行，不使用逗号、句号、问号、感叹号等标点。
- 网页历史库会自动保存每次翻译，并记录时间，可按歌手筛选。
- 历史记录可保存为单独 DOCX，也可直接下载 DOCX。
- 译文区域提供“反馈”入口，可对当前译文评分、填写问题说明，也可以按单句反馈调整译文。

## DOCX 历史库

默认 DOCX 保存目录：

```text
E:\codex.xm\歌词翻译网页\历史库
```

你可以在历史库窗口里修改保存路径，也可以用 `HISTORY_DIR` 环境变量指定。DOCX 文件名格式为：

```text
歌手 - 歌名 - YYYYMMDD-HHmmss.docx
```

DOCX 会按照 `templates/history-docx-template.docx` 的参考排版保存：歌名居中、歌手居中、保存时间和源语言右对齐，随后展示原词；原词结束后会自动分页，翻译从新页面开始。

如果网站部署到公网或云端，服务器通常不能写入你本机的 E 盘。这种情况下使用“下载 DOCX”按钮，把文档下载到当前设备。

## 质量迭代方案

听译集的第一版质量迭代靠“反馈闭环”完成：

1. 每次翻译后先在网页历史库自动留存记录。
2. 在译文区域点击“反馈”，对不满意的译文填写评分、问题说明和偏好，例如“太解释腔”“副歌重复句不统一”“更克制一些”。
3. 反馈会写入 `历史库/translation-feedback.json`。
4. 下一次翻译时，后端会读取最近反馈，整理成偏好提示交给模型。
5. 点“应用反馈重译”会用同一首歌重新翻译，让你比较新旧版本。

建议你每次只写最关键的 1 到 2 个问题。反馈越具体，下一轮质量越容易提升。

## 公网部署

要让别人像访问普通网站一样打开，需要部署到云平台，例如 Render、Railway、Fly.io 或自己的服务器。本项目支持 `npm start`，部署时通常设置：

```text
Start Command: npm start
Environment: HOST=0.0.0.0
```

如果在云端配置你的 API Key，别人使用网站会消耗你的额度。更安全的方式是不在云端配置 Key，让每个使用者在“配置接口”里填写自己的 API Key。

## 注意

这个工具只翻译你自己粘贴的文本，不会联网抓取歌词。歌词通常有版权，请只在合理范围内用于个人学习、理解和欣赏。
