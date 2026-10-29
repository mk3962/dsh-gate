/**
 * 用法：node --import ./test/stub-loader.mjs test/selftest.mjs
 * 作用：注册 test/stub-resolver.mjs，让插件源码里的 "@deepseek-ai/dsh-tools" 解析到离线替身。
 */
import { register } from "node:module";

register("./stub-resolver.mjs", import.meta.url);
