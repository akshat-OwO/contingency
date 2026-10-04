// Ridgeline Hardware is Contingency's bundled demo store. Every piece of state
// lives in this browser context's storage, so a fresh context is a clean store
// and one session's deliberate fault never reaches another session.

const STORAGE = {
  cart: "ridgeline.cart",
  fault: "ridgeline.fault",
  location: "ridgeline.location",
  returns: "ridgeline.returns",
  session: "ridgeline.session",
};

const FAULT_ADD_TO_CART = "add-to-cart";
const DEMO_EMAIL = "demo@ridgeline.test";
const MIN_PASSWORD_LENGTH = 8;

const PRODUCTS = [
  {
    description: "Fiberglass handle, 16 oz steel head.",
    id: "trail-hammer",
    name: "Trail Hammer",
    price: 24,
  },
  {
    description: "Japanese-style blade for clean cross cuts.",
    id: "cedar-saw",
    name: "Cedar Pull Saw",
    price: 38,
  },
  {
    description: "Six solid brass hinges with screws.",
    id: "hinge-set",
    name: "Brass Hinge Set",
    price: 12,
  },
  {
    description: "Forged trowel with depth markings.",
    id: "garden-trowel",
    name: "Garden Trowel",
    price: 15,
  },
  {
    description: "Magnetic hook and a locking blade.",
    id: "tape-measure",
    name: "25 ft Tape Measure",
    price: 18,
  },
  {
    description: "Split-grain leather with a cotton lining.",
    id: "work-gloves",
    name: "Leather Work Gloves",
    price: 22,
  },
];

const CITIES = {
  Boulder: ["Pearl Street", "Chautauqua", "Gunbarrel"],
  Denver: ["Capitol Hill", "Highlands", "Five Points"],
  "Fort Collins": ["Old Town", "Midtown"],
  Golden: ["Downtown Golden", "Pleasant View"],
};

const ORDERS = [
  { id: "RH-1042", placed: "September 12", product: "trail-hammer" },
  { id: "RH-1057", placed: "September 19", product: "cedar-saw" },
  { id: "RH-1063", placed: "September 26", product: "hinge-set" },
];

const RETURN_REASONS = [
  "Damaged on arrival",
  "Wrong item",
  "No longer needed",
  "Arrived too late",
];

const read = (key, fallback) => {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const productById = (id) => PRODUCTS.find((product) => product.id === id);

const element = (tag, properties = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (name === "text") {
      node.textContent = value;
    } else if (name === "className") {
      node.className = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
};

const money = (amount) => `$${amount.toFixed(2)}`;

/**
 * URL switches for the demo condition. `?fault=add-to-cart` breaks Add to
 * cart in this browser only, `?fault=off` restores it, and `?reset=all`
 * clears every piece of demo state. The switch is removed from the address
 * afterwards so a reload does not reapply it.
 */
const applyUrlSwitches = () => {
  const url = new URL(window.location.href);
  const fault = url.searchParams.get("fault");
  const reset = url.searchParams.get("reset");
  if (fault === null && reset === null) {
    return;
  }
  if (reset === "all") {
    for (const key of Object.values(STORAGE)) {
      localStorage.removeItem(key);
    }
  }
  if (fault === FAULT_ADD_TO_CART) {
    write(STORAGE.fault, FAULT_ADD_TO_CART);
  } else if (fault === "off") {
    localStorage.removeItem(STORAGE.fault);
  }
  url.searchParams.delete("fault");
  url.searchParams.delete("reset");
  window.history.replaceState(null, "", url);
};

const faultActive = () => read(STORAGE.fault, null) === FAULT_ADD_TO_CART;

const renderFaultBanner = () => {
  const banner = document.querySelector("#fault-banner");
  if (banner === null) {
    return;
  }
  banner.hidden = !faultActive();
  const restore = banner.querySelector("button");
  restore?.addEventListener("click", () => {
    localStorage.removeItem(STORAGE.fault);
    window.location.reload();
  });
};

const cartItems = () => read(STORAGE.cart, []);

const renderCartCount = () => {
  const link = document.querySelector("#cart-link");
  if (link === null) {
    return;
  }
  const count = cartItems().reduce((total, item) => total + item.quantity, 0);
  link.textContent = count === 0 ? "Cart (empty)" : `Cart (${count})`;
};

const renderAccountLink = () => {
  const link = document.querySelector("#account-link");
  if (link === null) {
    return;
  }
  const session = read(STORAGE.session, null);
  if (session === null) {
    link.textContent = "Sign in";
    link.setAttribute("href", "/signin.html");
    return;
  }
  link.textContent = "Your orders";
  link.setAttribute("href", "/orders.html");
};

const locationText = () => {
  const location = read(STORAGE.location, null);
  return location === null
    ? "No delivery location chosen"
    : `${location.area}, ${location.city}`;
};

const fillAreas = (citySelect, areaSelect, selectedArea) => {
  areaSelect.replaceChildren();
  const areas = CITIES[citySelect.value] ?? [];
  for (const area of areas) {
    const option = element("option", { text: area, value: area });
    if (area === selectedArea) {
      option.selected = true;
    }
    areaSelect.append(option);
  }
};

const setupLocationForm = () => {
  const form = document.querySelector("#location-form");
  if (form === null) {
    return;
  }
  const citySelect = form.querySelector("#city");
  const areaSelect = form.querySelector("#area");
  const status = document.querySelector("#location-status");
  const saved = read(STORAGE.location, null);
  for (const city of Object.keys(CITIES)) {
    const option = element("option", { text: city, value: city });
    if (saved?.city === city) {
      option.selected = true;
    }
    citySelect.append(option);
  }
  fillAreas(citySelect, areaSelect, saved?.area);
  citySelect.addEventListener("change", () => {
    fillAreas(citySelect, areaSelect, null);
  });
  status.textContent = `Delivering to: ${locationText()}`;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    write(STORAGE.location, { area: areaSelect.value, city: citySelect.value });
    status.textContent = `Delivering to: ${locationText()}`;
  });
};

const addToCart = (productId) => {
  const items = cartItems();
  const existing = items.find((item) => item.productId === productId);
  if (existing === undefined) {
    items.push({ productId, quantity: 1 });
  } else {
    existing.quantity += 1;
  }
  write(STORAGE.cart, items);
};

const renderShop = () => {
  const list = document.querySelector("#products");
  const status = document.querySelector("#cart-status");
  for (const product of PRODUCTS) {
    const button = element("button", {
      "aria-label": `Add ${product.name} to cart`,
      text: "Add to cart",
      type: "button",
    });
    button.addEventListener("click", () => {
      // The deliberate fault looks like success but never stores the item:
      // only the cart itself shows that the journey failed.
      if (!faultActive()) {
        addToCart(product.id);
      }
      status.textContent = `${product.name} added to cart.`;
      renderCartCount();
    });
    list.append(
      element("li", { className: "product" }, [
        element("h3", { text: product.name }),
        element("p", { text: product.description }),
        element("p", { className: "price", text: money(product.price) }),
        button,
      ])
    );
  }
};

const renderCart = () => {
  const body = document.querySelector("#cart-rows");
  const empty = document.querySelector("#cart-empty");
  const table = document.querySelector("#cart-table");
  const total = document.querySelector("#cart-total");
  const delivery = document.querySelector("#cart-location");
  delivery.textContent = locationText();
  const items = cartItems();
  body.replaceChildren();
  empty.hidden = items.length > 0;
  table.hidden = items.length === 0;
  let sum = 0;
  for (const item of items) {
    const product = productById(item.productId);
    if (product === undefined) {
      continue;
    }
    sum += product.price * item.quantity;
    const remove = element("button", {
      "aria-label": `Remove ${product.name}`,
      className: "secondary",
      text: "Remove",
      type: "button",
    });
    remove.addEventListener("click", () => {
      write(
        STORAGE.cart,
        cartItems().filter((entry) => entry.productId !== item.productId)
      );
      renderCart();
      renderCartCount();
    });
    body.append(
      element("tr", {}, [
        element("td", { text: product.name }),
        element("td", { text: String(item.quantity) }),
        element("td", { text: money(product.price * item.quantity) }),
        element("td", {}, [remove]),
      ])
    );
  }
  total.textContent = money(sum);
};

const setupSignIn = () => {
  const form = document.querySelector("#signin-form");
  const error = document.querySelector("#signin-error");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = form.querySelector("#email").value.trim().toLowerCase();
    const password = form.querySelector("#password").value;
    if (email !== DEMO_EMAIL || password.length < MIN_PASSWORD_LENGTH) {
      error.textContent = `Sign in with ${DEMO_EMAIL} and a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
      return;
    }
    write(STORAGE.session, { email, signedInAt: new Date().toISOString() });
    window.location.assign("/orders.html");
  });
};

const requireSession = () => {
  if (read(STORAGE.session, null) === null) {
    window.location.replace("/signin.html");
    return false;
  }
  return true;
};

const setupSignOut = () => {
  const button = document.querySelector("#signout");
  button?.addEventListener("click", () => {
    localStorage.removeItem(STORAGE.session);
    window.location.assign("/");
  });
};

const renderOrders = () => {
  if (!requireSession()) {
    return;
  }
  const body = document.querySelector("#order-rows");
  const returns = new Map(
    read(STORAGE.returns, []).map((entry) => [entry.orderId, entry])
  );
  for (const order of ORDERS) {
    const product = productById(order.product);
    const started = returns.get(order.id);
    const action = started
      ? element("span", { text: `Return ${started.id} started` })
      : element("a", {
          href: `/return.html?order=${order.id}`,
          text: `Start a return for ${order.id}`,
        });
    body.append(
      element("tr", {}, [
        element("td", { text: order.id }),
        element("td", { text: product?.name ?? order.product }),
        element("td", { text: order.placed }),
        element("td", {}, [action]),
      ])
    );
  }
};

const renderReturn = () => {
  if (!requireSession()) {
    return;
  }
  const orderId = new URL(window.location.href).searchParams.get("order");
  const order = ORDERS.find((entry) => entry.id === orderId);
  const form = document.querySelector("#return-form");
  const heading = document.querySelector("#return-heading");
  const confirmation = document.querySelector("#return-confirmation");
  if (order === undefined) {
    heading.textContent = "Choose an order to return";
    form.hidden = true;
    return;
  }
  const product = productById(order.product);
  heading.textContent = `Return order ${order.id}`;
  document.querySelector("#return-product").textContent =
    product?.name ?? order.product;
  const reason = form.querySelector("#reason");
  for (const text of RETURN_REASONS) {
    reason.append(element("option", { text, value: text }));
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const returns = read(STORAGE.returns, []);
    const id = `RR-${order.id.slice(3)}-${returns.length + 1}`;
    returns.push({ id, orderId: order.id, reason: reason.value });
    write(STORAGE.returns, returns);
    form.hidden = true;
    confirmation.hidden = false;
    confirmation.querySelector("#confirmation-text").textContent =
      `Return ${id} started for order ${order.id} (${product?.name ?? order.product}). Reason: ${reason.value}.`;
    confirmation.querySelector("h2").focus();
  });
};

const PAGES = {
  cart: renderCart,
  orders: renderOrders,
  return: renderReturn,
  shop: () => {
    setupLocationForm();
    renderShop();
  },
  signin: setupSignIn,
};

applyUrlSwitches();
renderFaultBanner();
renderCartCount();
renderAccountLink();
setupSignOut();
PAGES[document.body.dataset.page]?.();
