// Vite 与 mygo dev 共用的开发服务器端口：前者用它监听，后者用它拼 devUrl，两边只有读同一个数字才会碰上。
// 默认的 5173 是人人都在用的端口，另一个项目忘了改就会来抢，所以这里挑一个少见的；
// 也刻意避开 macOS 的临时端口段（49152 起），免得某个出站连接碰巧占掉它。
export const DEV_PORT = 18731;

/** devUrl 是面板在开发时加载的地址。 */
export const DEV_URL = `http://localhost:${DEV_PORT}`;
