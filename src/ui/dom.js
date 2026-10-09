// Small DOM builders. Text goes through textContent only.

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, attribute] of Object.entries(attributes)) {
    if (attribute === undefined || attribute === null || attribute === false) continue;
    if (name === 'class') node.className = attribute;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), attribute);
    else if (name === 'value') node.value = attribute;
    else node.setAttribute(name, attribute === true ? '' : String(attribute));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof window.Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let counter = 0;
export const uniqueId = (prefix) => `${prefix}-${++counter}`;
