CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"price" real NOT NULL,
	"cost" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"province" text NOT NULL,
	"address" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'قيد المعالجة' NOT NULL,
	"total_amount" real DEFAULT 0 NOT NULL,
	"shipping_cost" real DEFAULT 0 NOT NULL,
	"total_profit" real DEFAULT 0 NOT NULL,
	"promo_code" text DEFAULT '' NOT NULL,
	"promo_discount" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"company_wholesale_price" real DEFAULT 0 NOT NULL,
	"wholesale_price" real NOT NULL,
	"suggested_price" real DEFAULT 0,
	"selling_price_min" real NOT NULL,
	"category" text DEFAULT 'عام' NOT NULL,
	"image_url" text DEFAULT '' NOT NULL,
	"images" text DEFAULT '' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"is_renewable" boolean DEFAULT false NOT NULL,
	"discount" real DEFAULT 0 NOT NULL,
	"ad_links" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"discount_percent" real NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"password" text NOT NULL,
	"store_name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'merchant' NOT NULL,
	"merchant_id" text NOT NULL,
	"balance" real DEFAULT 0 NOT NULL,
	"pending_balance" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_merchant_id_unique" UNIQUE("merchant_id")
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"amount" real NOT NULL,
	"method" text NOT NULL,
	"account_details" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'قيد المعالجة' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
