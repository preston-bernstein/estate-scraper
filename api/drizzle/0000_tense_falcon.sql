CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` text NOT NULL,
	`image_url` text NOT NULL,
	`description` text NOT NULL,
	`scraped_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`sale_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hunts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_sub` text NOT NULL,
	`name` text NOT NULL,
	`keywords` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_sub` text NOT NULL,
	`sale_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`sale_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`sale_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`address` text NOT NULL,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`zip` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`distance_miles` real NOT NULL,
	`scraped_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`owner_sub` text PRIMARY KEY NOT NULL,
	`radius_miles` real NOT NULL
);
