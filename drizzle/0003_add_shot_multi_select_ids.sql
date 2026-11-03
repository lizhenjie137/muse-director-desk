ALTER TABLE `shots` ADD COLUMN `character_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shots` ADD COLUMN `scene_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE `shots` SET `character_ids` = CASE WHEN `character_id` IS NOT NULL THEN json_array(`character_id`) ELSE '[]' END, `scene_ids` = CASE WHEN `scene_id` IS NOT NULL THEN json_array(`scene_id`) ELSE '[]' END;
