// 预加载脚本暴露的联机 API 类型声明
export {};

declare global {
  interface Window {
    lyceeNet: {
      startServer(port: number): Promise<{ ok: boolean; message?: string }>;
      stopServer(): Promise<{ ok: boolean }>;
      /** 广播给所有已连接客户端 */
      broadcast(msg: string): void;
      /** 定向发送给指定客户端 */
      sendTo(id: number, msg: string): void;
      /** 客户端连接/消息/断开（返回取消订阅函数） */
      onClientConnected(cb: (id: number) => void): () => void;
      onClientMessage(cb: (m: { id: number; msg: string }) => void): () => void;
      onClientDisconnected(cb: (id: number) => void): () => void;
    };
    lyceeSongs: {
      list(): Promise<{ file: string; name: string; url: string }[]>;
    };
    lyceeVoices: {
      list(): Promise<{ name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]>;
    };
    /** 自建中继服务器地址（data/relay.txt）；返回空字符串表示用内置默认地址 */
    lyceeRelay: {
      url(): Promise<string>;
    };
  }
}
