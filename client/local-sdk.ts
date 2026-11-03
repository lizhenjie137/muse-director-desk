// 平台客户端适配（替换源码包的 client 本机适配）：
// - 动作 RPC 改由 @hatch/space-sdk/client 提供（见 src/api.ts），本文件只
//   保留原页面用到的两个纯客户端工具，签名与源码版一致。
// - localAssetUrl：源码版从本机私有数据映射解析 asset: 原件地址。本构件
//   不导入私人数据包，没有可解析的原件映射，恒返回 null——页面会按原
//   逻辑保留“缺图”占位并明示，绝不拿其他图片冒充原件。

export function fileToBase64(file: Blob): Promise<{ dataBase64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取所选文件，请重新选择原文件。"));
    reader.onabort = () => reject(new Error("文件读取已取消。"));
    reader.onload = () => {
      const result = reader.result;
      const separator = typeof result === "string" ? result.indexOf(",") : -1;
      if (typeof result !== "string" || separator < 0 || !result.slice(0, separator).endsWith(";base64")) {
        reject(new Error("所选文件无法转换为可上传内容。"));
        return;
      }
      resolve({ dataBase64: result.slice(separator + 1), mimeType: file.type || "application/octet-stream" });
    };
    reader.readAsDataURL(file);
  });
}

export function localAssetUrl(_key: string): string | null {
  return null;
}
