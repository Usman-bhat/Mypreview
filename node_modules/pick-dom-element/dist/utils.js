;
export const getElementBounds = (el) => {
    const rect = el.getBoundingClientRect();
    return {
        x: window.pageXOffset + rect.left,
        y: window.pageYOffset + rect.top,
        width: el.offsetWidth,
        height: el.offsetHeight,
    };
};
