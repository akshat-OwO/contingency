// React Native convention keeps StyleSheet.create after the components that use it.
/* oxlint-disable eslint/no-use-before-define */
import Constants from "expo-constants";
import { useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

// State lives in memory only, so restarting the activity is a fresh start.
const variant = Constants.expoConfig?.extra?.fixtureVariant ?? "working";
const products =
  variant === "changed"
    ? [
        { name: "Feather", price: "$2" },
        { name: "Anvil", price: "$40" },
      ]
    : [{ name: "Anvil", price: "$40" }];

const Action = ({ label, onPress }) => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    onPress={onPress}
    style={styles.button}
  >
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>
);

const SignIn = ({ onSignIn }) => {
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        Fixture Shop sign in
      </Text>
      <Text>Use a public fixture name. No password is requested.</Text>
      <TextInput
        accessibilityLabel="Shopper name"
        autoCapitalize="words"
        autoCorrect={false}
        onChangeText={setName}
        placeholder="Shopper name"
        style={styles.input}
        value={name}
      />
      {missing ? <Text>Enter a shopper name first.</Text> : null}
      <Action
        label="Sign in"
        onPress={() => {
          if (name.trim() === "") {
            setMissing(true);
            return;
          }
          onSignIn(name.trim());
        }}
      />
    </View>
  );
};

const Catalog = ({ shopper, cart, onAdd, onOpenCart }) => (
  <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>
      Catalog
    </Text>
    <Text>Signed in as {shopper}</Text>
    {variant === "changed" ? (
      <Text style={styles.banner}>Spring sale: free mock shipping</Text>
    ) : null}
    {products.map((product) => (
      <View key={product.name} style={styles.product}>
        <Text style={styles.productName}>
          {product.name} {product.price}
        </Text>
        <Action
          label={`Add ${product.name} to cart`}
          onPress={() => onAdd(product.name)}
        />
      </View>
    ))}
    <Text>
      Cart: {cart.length} {cart.length === 1 ? "item" : "items"}
    </Text>
    <Action label="Open cart" onPress={onOpenCart} />
  </View>
);

const Cart = ({ cart, onPlace }) => (
  <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>
      Cart
    </Text>
    {cart.length === 0 ? <Text>Your cart is empty</Text> : null}
    {cart.map((item, index) => (
      // Duplicate items are allowed; their position is their identity.
      // oxlint-disable-next-line react-doctor/no-array-index-as-key
      <Text key={`${item}-${index}`}>{item} × 1</Text>
    ))}
    {variant === "changed" ? <Text>Mock shipping: free</Text> : null}
    {cart.length > 0 ? (
      <Action label="Place mock order" onPress={onPlace} />
    ) : null}
  </View>
);

const Result = ({ cart }) =>
  variant === "broken" ? (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        Checkout failed
      </Text>
      <Text>Mock payment service unavailable. No order was placed.</Text>
    </View>
  ) : (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        Order confirmed
      </Text>
      <Text>Mock order for {cart.join(", ")}. No payment was taken.</Text>
    </View>
  );

export const Shop = () => {
  const [shopper, setShopper] = useState(null);
  const [cart, setCart] = useState([]);
  const [screen, setScreen] = useState("catalog");
  let content = <SignIn onSignIn={setShopper} />;
  if (shopper !== null && screen === "catalog") {
    content = (
      <Catalog
        cart={cart}
        onAdd={(name) => setCart((current) => [...current, name])}
        onOpenCart={() => setScreen("cart")}
        shopper={shopper}
      />
    );
  } else if (shopper !== null && screen === "cart") {
    content = <Cart cart={cart} onPlace={() => setScreen("result")} />;
  } else if (shopper !== null) {
    content = <Result cart={cart} />;
  }
  return (
    <SafeAreaView style={styles.screen}>
      {/* A tap on a button while the keyboard is open must press it, not only dismiss the keyboard. */}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {content}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  banner: { backgroundColor: "#fde68a", padding: 8 },
  button: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  content: { padding: 24, paddingTop: 64 },
  input: {
    borderColor: "#64748b",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  product: { gap: 8 },
  productName: { fontSize: 18 },
  screen: { backgroundColor: "#ffffff", flex: 1 },
  section: { gap: 16 },
  title: { fontSize: 24, fontWeight: "700" },
});
