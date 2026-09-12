export const RESPONSIVE_PRESET_ID = "responsive";

export const devicePresets = [
  { height: 667, id: "iphone-se", name: "iPhone SE", width: 375 },
  { height: 896, id: "iphone-xr", name: "iPhone XR", width: 414 },
  { height: 844, id: "iphone-12-pro", name: "iPhone 12 Pro", width: 390 },
  {
    height: 932,
    id: "iphone-14-pro-max",
    name: "iPhone 14 Pro Max",
    width: 430,
  },
  { height: 915, id: "pixel-7", name: "Pixel 7", width: 412 },
  {
    height: 740,
    id: "samsung-galaxy-s8-plus",
    name: "Samsung Galaxy S8+",
    width: 360,
  },
  {
    height: 915,
    id: "samsung-galaxy-s20-ultra",
    name: "Samsung Galaxy S20 Ultra",
    width: 412,
  },
  { height: 1024, id: "ipad-mini", name: "iPad Mini", width: 768 },
  { height: 1180, id: "ipad-air", name: "iPad Air", width: 820 },
  { height: 1366, id: "ipad-pro", name: "iPad Pro", width: 1024 },
  { height: 1368, id: "surface-pro-7", name: "Surface Pro 7", width: 912 },
  { height: 720, id: "surface-duo", name: "Surface Duo", width: 540 },
  { height: 882, id: "galaxy-z-fold-5", name: "Galaxy Z Fold 5", width: 344 },
  {
    height: 1280,
    id: "asus-zenbook-fold",
    name: "Asus Zenbook Fold",
    width: 853,
  },
  {
    height: 914,
    id: "samsung-galaxy-a51-71",
    name: "Samsung Galaxy A51/71",
    width: 412,
  },
  { height: 600, id: "nest-hub", name: "Nest Hub", width: 1024 },
  { height: 800, id: "nest-hub-max", name: "Nest Hub Max", width: 1280 },
] as const;

export const presetName = (presetId: string): string => {
  if (presetId === RESPONSIVE_PRESET_ID) {
    return "Responsive";
  }
  return devicePresets.find(({ id }) => id === presetId)?.name ?? "Responsive";
};
