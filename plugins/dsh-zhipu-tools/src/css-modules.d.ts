// CSS Modules 类型垫片：lightningcss 编译产物的默认导出是
// { 源类名 → 哈希类名 } 映射（见 tsdown.config.ts 的 dsh-css-modules-inline）。
declare module '*.module.css' {
	const classes: Record<string, string>
	export default classes
}
