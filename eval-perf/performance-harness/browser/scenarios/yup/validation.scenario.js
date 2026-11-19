import * as yup from "yup";

function createCheckoutSchema() {
  return yup.object({
    id: yup.string().required().matches(/^checkout-/),
    email: yup.string().required().email(),
    items: yup.array().of(
      yup.object({
        sku: yup.string().required().min(3),
        quantity: yup.number().required().integer().positive(),
        price: yup.number().required().positive(),
      }),
    ).required().min(1),
    coupon: yup.string().optional(),
    acceptedTerms: yup.boolean().oneOf([true]).required(),
  });
}

const checkouts = Array.from({ length: 40 }, (_, index) => ({
  id: `checkout-${index + 1}`,
  email: `customer${index + 1}@example.com`,
  items: [
    { sku: `sku-${index % 8}`, quantity: 1 + (index % 3), price: 9.5 + index },
    { sku: `sku-${(index + 4) % 8}`, quantity: 1, price: 4.25 },
  ],
  coupon: index % 5 === 0 ? "SAVE10" : undefined,
  acceptedTerms: true,
}));

const invalidCheckout = {
  id: "bad",
  email: "not-an-email",
  items: [],
  acceptedTerms: false,
};

export default function run() {
  const checkoutSchema = createCheckoutSchema();
  const parsed = checkouts.map((checkout) => checkoutSchema.validateSync(checkout));
  const total = parsed.reduce(
    (sum, checkout) =>
      sum + checkout.items.reduce((itemSum, item) => itemSum + item.quantity * item.price, 0),
    0,
  );
  const invalid = checkoutSchema.isValidSync(invalidCheckout);

  if (parsed.length !== checkouts.length || total <= 0 || invalid) {
    throw new Error("Yup scenario produced invalid validation output.");
  }
}
