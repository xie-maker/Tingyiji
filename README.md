# 听译集

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xie-maker/Tingyiji)

听译集是一个外文歌曲歌词译中网页工具。你粘贴外文歌词，填写歌名和歌手，选择翻译偏好和大模型接口后，它会把歌词翻译成中文，并保留原文换行做逐行对照。

## 本地启动

```powershell
npm start
```

如果系统里的 `node` 提示 Access denied，可以使用 Codex 自带 Node：

```powershell
& "C:\Users\xie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
```

启动后打开：

```text
http://localhost:3000
```

## API 接口

页面右上角点“配置接口”，可以管理最多 5 个接口配置。每个配置都可以选择 OpenAI、DeepSeek、通义千问、Moonshot、智谱 GLM 或自定义 OpenAI-compatible API，并独立保存供应商、Base URL、模型和 API Key 保存状态。

公开部署时建议不要在服务器环境变量里放你的 API Key，让使用者在网页“配置接口”里填写自己的 Key。API Key 默认只保存在当前浏览器本地。

## 功能

- 支持全部外文歌曲歌词翻译成中文，默认自动识别源语言。
- 支持歌名、歌手、源语言和丰富翻译偏好。
- 翻译偏好会自动保存为下次默认，并随历史记录一起保存。
- 输出译文固定使用空格和换行，不使用逗号、句号、问号、感叹号等标点。
- 网页历史库会自动保存每次翻译，并记录时间，可按歌手筛选。
- 历史记录可保存为单独 DOCX，也可直接下载 DOCX。
- 译文区域提供“反馈”入口，可对当前译文评分、填写问题说明，也可以按单句反馈调整译文。

## DOCX 历史库

本机运行时，DOCX 默认保存目录：

```text
E:\codex.xm\歌词翻译网页\历史库
```

也可以用 `HISTORY_DIR` 环境变量或历史库窗口里的保存路径指定目录。DOCX 文件名格式为：

```text
歌手 - 歌名 - YYYYMMDD-HHmmss.docx
```

DOCX 使用内置排版生成：歌名居中、歌手居中、保存时间和源语言右对齐，随后展示原词；原词结束后自动分页，翻译从新页面开始。

如果网站部署到公网或云端，服务器通常不能写入你本机的 E 盘。这种情况下使用“下载 DOCX”按钮，把文档下载到当前设备。

## Render 部署

点击 README 顶部的 `Deploy to Render` 按钮，或在 Render 新建 Web Service 并连接本仓库。

推荐设置：

```text
Build Command: npm install
Start Command: npm start
Environment: HOST=0.0.0.0
```

不要在 Render 里设置你的 `OPENAI_API_KEY`，除非你已经准备好登录、限流和额度控制。更安全的公开版方式是让每个使用者自己填写 API Key。

## 注意

这个工具只翻译用户自己粘贴的文本，不会联网抓取歌词。歌词通常有版权，请只在合理范围内用于个人学习、理解和欣赏。
