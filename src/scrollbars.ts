// 滚动条滑块：平时不出现，滚动时淡入，停下 700ms 后淡出。
// WebKit 不会给 ::-webkit-scrollbar 的样式改动重绘（要等指针悬停到滚动条上），
// 所以原生滚动条在 style.css 里整条隐藏，滑块改由这里画。监听 document 上的
// scroll 事件（捕获阶段，滚动事件不冒泡），把触发滚动的元素对应的一枚 6px 滑块
// 放到它在视口中的位置，滚动停下后收起来。滑块不接收点击，滚轮、触控板、键盘
// 照常滚动。职责仅限滚动条的显示与定位，不改变任何滚动区域的内容和尺寸。
const HIDE_DELAY = 700;
const MIN_THUMB_HEIGHT = 24;
// 与 style.css 里 .scrollbar-thumb 的 width 一致。
const THUMB_WIDTH = 6;

const layer = document.createElement("div");
layer.className = "scrollbar-layer";

const thumbs = new WeakMap<Element, HTMLElement>();
const hideTimers = new WeakMap<Element, number>();
const showing = new Set<Element>();
let frame = 0;

function thumbFor(scroller: Element): HTMLElement {
  let thumb = thumbs.get(scroller);
  if (!thumb) {
    thumb = document.createElement("div");
    thumb.className = "scrollbar-thumb";
    layer.append(thumb);
    thumbs.set(scroller, thumb);
  }
  return thumb;
}

/** place puts the thumb where the scroller's position in view says it belongs,
    and takes it away when there is nothing to scroll. */
function place(scroller: Element, thumb: HTMLElement) {
  const view = scroller.clientHeight;
  const total = scroller.scrollHeight;
  if (view <= 0 || total <= view) {
    thumb.classList.remove("is-visible");
    return;
  }
  // The thumb is as much of the track as the view is of the whole scroll: it
  // never gets shorter than MIN_THUMB_HEIGHT, so a long note still has
  // something to grab.
  const height = Math.min(view, Math.max(MIN_THUMB_HEIGHT, (view * view) / total));
  const travel = view - height;
  const ridden = Math.min(travel, Math.max(0, (scroller.scrollTop / (total - view)) * travel));
  const rect = scroller.getBoundingClientRect();
  thumb.style.height = `${height}px`;
  thumb.style.transform = `translate(${
    rect.left + scroller.clientLeft + scroller.clientWidth - THUMB_WIDTH
  }px, ${rect.top + scroller.clientTop + ridden}px)`;
  thumb.classList.add("is-visible");
}

function tick() {
  frame = 0;
  for (const scroller of showing) {
    const thumb = thumbs.get(scroller);
    if (!thumb) continue;
    // A re-rendered sidebar leaves its old scroller in the set with nothing on
    // screen to point at.
    if (!scroller.isConnected) {
      showing.delete(scroller);
      thumb.remove();
      continue;
    }
    place(scroller, thumb);
  }
  // Overflow can change under a still pointer, and so can the window, so a
  // visible thumb keeps following its scroller for as long as it is shown.
  if (showing.size) frame = requestAnimationFrame(tick);
}

export function watchScrollbars() {
  document.body.append(layer);
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      const scroller = target instanceof Element ? target : document.scrollingElement;
      if (!(scroller instanceof Element)) return;
      place(scroller, thumbFor(scroller));
      showing.add(scroller);
      if (!frame) frame = requestAnimationFrame(tick);
      window.clearTimeout(hideTimers.get(scroller));
      hideTimers.set(
        scroller,
        window.setTimeout(() => {
          showing.delete(scroller);
          thumbs.get(scroller)?.classList.remove("is-visible");
        }, HIDE_DELAY),
      );
    },
    { capture: true, passive: true },
  );
}
