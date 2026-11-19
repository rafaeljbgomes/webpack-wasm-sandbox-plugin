import _ from "sandbox-real/lodash";

export function summarizeOrders(orders) {
  const completedOrders = _.filter(orders, { status: "completed" });
  const totalsByRegion = _.mapValues(
    _.groupBy(completedOrders, "region"),
    (regionOrders) => _.sumBy(regionOrders, "total"),
  );
  const premiumCustomerNames = _.chain(completedOrders)
    .filter((order) => order.customer.tier === "premium")
    .orderBy(["total", "customer.name"], ["desc", "asc"])
    .take(10)
    .map("customer.name")
    .value();
  const itemQuantities = _.chain(completedOrders)
    .flatMap("items")
    .groupBy("sku")
    .mapValues((items) => _.sumBy(items, "quantity"))
    .value();

  return {
    totalsByRegion,
    premiumCustomerNames,
    itemQuantities,
  };
}
