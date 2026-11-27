<div align="center">
  <img src="assets/icon.png" width="56" alt="颜色助手">
  <h1>颜色助手</h1>
  <p>从屏幕取色、转换色值，或通过色卡与渐变制作配色。</p>
  <p>
    <a href="../../README.md#插件列表">插件列表</a>
    ·
    <a href="../../README.md#安装">安装指南</a>
  </p>
</div>

[使用](#使用) · [快速取色](#快速取色) · [转换与配色](#转换与配色) · [AI 配色](#ai-配色) · [从源码构建](#从源码构建) · [参考](#参考)

## 使用

在 Tinycast 搜索 **颜色助手**。进入插件后粘贴 `#6E64D0`、`rgb(110 100 208 / 50%)` 或 `hsl(246 53% 60%)`，按回车打开转换结果。也可从工具列表打开屏幕取色，点击屏幕上的像素后查看并复制色值。

## 快速取色

在 Tinycast 主搜索运行「快速屏幕取色」，点击像素后自动复制。默认复制大写 HEX，可在扩展偏好设置切换为小写 HEX、RGB 或 HSL，也可为命令设置快捷键。屏幕取色会记录到「最近取色」，最多保留 50 个不同色值。打开历史即可再次复制、查看或收藏。

## 转换与配色

- **颜色转换与对比** 支持 HEX、RGB(A)、HSL(A)、HSV / HSB 和 CMYK 输入，还可查看 HSI、CIE Lab 和互补色等搭配。颜色对比以第一项为背景，显示其余颜色与背景的 WCAG 对比度。
- **图片色卡** 支持选取本地图片，或按 `⌘⇧V` 从剪贴板图片提取主色。色卡可复制色值或导出 PNG。
- **UI 色卡与传统色** 提供 Flat UI、Fluent Design、Open Color、Ant Design、Material Design，以及按二十四节气分组的 384 个中国传统色和 250 个日本传统色。列表支持按色名或 HEX 搜索。
- **渐变与收藏** 可调整色标与角度、复制 CSS，并指定尺寸导出 PNG。单色、色卡和渐变都能保存在本机收藏列表。

## AI 配色

在「AI 配色 → AI 接口配置」填写兼容 OpenAI 的 API 地址、模型和密钥。可按主色、风格和冷暖出配色，也可对已有色板命名并生成 PNG 图片。生图需配置返回 PNG Base64 的图像模型。地址和模型保存在本机，密钥随本次插件运行结束清除。

## 从源码构建

从源码运行 `pnpm --filter noah-color build` 需要 macOS 和 Xcode Command Line Tools。产物中的取色程序同时支持 Apple Silicon 和 Intel。

## 参考

- 颜色转换与对比、图片色卡、UI 色卡、传统色、渐变和 AI 配色的功能设计参考了 [uTools 颜色助手](https://www.u-tools.cn/plugins/detail/%E9%A2%9C%E8%89%B2%E5%8A%A9%E6%89%8B/)。
- 独立取色命令、点选后自动复制、可选复制格式和最近取色记录的交互参考了 [Raycast Color Picker 源码（`8d84639`）](https://github.com/raycast/extensions/tree/8d846393b506d23c5d9ebae29bb35e3dc7653829/extensions/color-picker/)。
- UI 色卡和传统色的数据来源见 [色卡来源清单](assets/palette-sources.txt)，对应许可证位于同一目录。
