/**
 * Industry presets.
 *
 * One entry per business type. Each names the sections that vertical actually
 * needs, the 3D subjects worth generating for it, and — the field that matters
 * most — whether the site requires user accounts.
 *
 * ## Why this file exists
 *
 * Without it, every generation run re-derives "what sections does a dentist
 * need" from scratch, and the answer drifts run to run. Worse, a model with no
 * preset tends toward the safe brochure: hero, about, contact. That is how a
 * streaming service ends up shipping without a login, and a pizzeria ends up
 * with prices typed into the markup.
 *
 * A preset turns generation into a lookup. The model is not deciding whether a
 * gym needs recurring billing; the preset already says it does.
 *
 * ## The commerce field is a hard requirement, not a hint
 *
 *   one_time      — products table, Stripe Checkout, guest or account
 *   subscription  — Stripe subscription + billing portal. ALWAYS needs auth.
 *   booking       — appointment records tied to a user. ALWAYS needs auth,
 *                   because a booking nobody can identify cannot be cancelled
 *                   or amended by the person who made it.
 *   quote         — encrypted submission, no payment
 *   none          — informational only
 *
 * ## The auth field decides whether the backend ships
 *
 *   required — auth routes, account pages, and session handling are wired in.
 *              Omitting them does not produce a simpler site, it produces a
 *              non-functional one.
 *   optional — guest checkout works; accounts add order history.
 *   none     — no user accounts. The admin dashboard still exists.
 *
 * Add a vertical by adding an entry. Do not invent one at generation time — if
 * a brief names a business type absent from this file, that is a signal the
 * preset list needs extending, and it belongs in a commit rather than in a
 * single site's output.
 */

export type CommerceModel = 'one_time' | 'subscription' | 'booking' | 'quote' | 'none';
export type AuthRequirement = 'required' | 'optional' | 'none';

export interface IndustryPreset {
  id: string;
  label: string;
  category: string;
  commerce: CommerceModel;
  auth: AuthRequirement;
  /** Section keys, in page order. Every key exists in sections/index.ts. */
  sections: string[];
  /** Manifest keys to generate 3D for. Two is the working default — more costs
   *  Higgsfield credits and page weight for diminishing returns. */
  subjects: string[];
  /** Vertical-specific guidance. Read it; these are the traps in that trade. */
  note?: string;
}

export const INDUSTRY_PRESETS: IndustryPreset[] = [

  /* ---- FOOD BEVERAGE ---- */
  {
    id: "pizzeria", label: "Pizzeria", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "proof", "faq", "cta_band"],
    subjects: ["signature_dish", "oven_or_kitchen"],
    note: "Menu is the pricing section \u2014 items come from the products table, never markup.",
  },
  {
    id: "burger_joint", label: "Burger restaurant", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "gallery", "cta_band"],
    subjects: ["signature_burger", "sides_spread"],
  },
  {
    id: "sushi_restaurant", label: "Sushi restaurant", category: "food_beverage",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "editorial_long", "pricing", "location_hours", "proof", "contact_form"],
    subjects: ["signature_plate", "counter_setting"],
    note: "Booking needs accounts \u2014 a reservation without an identity cannot be modified or cancelled by the guest.",
  },
  {
    id: "fine_dining", label: "Fine dining", category: "food_beverage",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "editorial_long", "gallery", "team", "location_hours", "contact_form"],
    subjects: ["signature_plate", "dining_room"],
  },
  {
    id: "cafe_coffee", label: "Cafe / coffee shop", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "gallery", "cta_band"],
    subjects: ["coffee_service", "roastery_detail"],
  },
  {
    id: "bakery", label: "Bakery", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "proof", "cta_band"],
    subjects: ["signature_bake", "display_case"],
  },
  {
    id: "grocery_store", label: "Grocery / market", category: "food_beverage",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "faq", "cta_band"],
    subjects: ["produce_arrangement", "storefront"],
    note: "Accounts required: repeat orders, saved baskets, and delivery addresses all need an identity.",
  },
  {
    id: "butcher", label: "Butcher", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "editorial_long", "contact_form"],
    subjects: ["cut_display", "counter"],
  },
  {
    id: "food_truck", label: "Food truck", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "pricing", "location_hours", "gallery", "cta_band"],
    subjects: ["signature_dish", "truck_exterior"],
    note: "location_hours carries the pitch schedule \u2014 the one section a truck cannot do without.",
  },
  {
    id: "catering", label: "Catering", category: "food_beverage",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "process_timeline", "gallery", "proof", "contact_form"],
    subjects: ["plated_spread", "event_setup"],
  },
  {
    id: "brewery", label: "Brewery", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "product_showcase_3d", "feature_grid", "location_hours", "editorial_long", "cta_band"],
    subjects: ["bottle_or_can", "brewhouse"],
  },
  {
    id: "winery", label: "Winery", category: "food_beverage",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "editorial_long", "pricing", "location_hours", "contact_form"],
    subjects: ["bottle", "vineyard_detail"],
    note: "Age verification and shipping restrictions make accounts non-optional.",
  },
  {
    id: "bar_pub", label: "Bar / pub", category: "food_beverage",
    commerce: "none", auth: "none",
    sections: ["hero3d", "feature_grid", "location_hours", "gallery", "cta_band"],
    subjects: ["signature_drink", "interior"],
  },
  {
    id: "juice_bar", label: "Juice / smoothie bar", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "pricing", "feature_grid", "location_hours", "cta_band"],
    subjects: ["signature_drink", "ingredient_spread"],
  },
  {
    id: "ice_cream", label: "Ice cream / dessert", category: "food_beverage",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "cta_band"],
    subjects: ["signature_dessert", "storefront"],
  },
  {
    id: "meal_prep", label: "Meal prep / delivery", category: "food_beverage",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "process_timeline", "proof", "faq", "cta_band"],
    subjects: ["meal_container", "weekly_spread"],
    note: "Recurring billing \u2014 subscription state lives server-side and needs an authenticated account.",
  },
  {
    id: "ghost_kitchen", label: "Ghost kitchen / delivery-only", category: "food_beverage",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "pricing", "feature_grid", "faq", "cta_band"],
    subjects: ["signature_dish", "packaging"],
  },

  /* ---- RETAIL ---- */
  {
    id: "clothing_boutique", label: "Clothing boutique", category: "retail",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "product_showcase_3d", "proof", "faq", "cta_band"],
    subjects: ["hero_garment", "detail_texture"],
  },
  {
    id: "jewellery", label: "Jewellery", category: "retail",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "gallery", "editorial_long", "proof", "contact_form"],
    subjects: ["hero_piece", "material_detail"],
    note: "3D earns its place here more than almost anywhere \u2014 rotation shows what a photo cannot.",
  },
  {
    id: "furniture", label: "Furniture", category: "retail",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "gallery", "feature_grid", "faq", "cta_band"],
    subjects: ["hero_piece", "joinery_detail"],
  },
  {
    id: "sneaker_streetwear", label: "Sneakers / streetwear", category: "retail",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "gallery", "stat_band", "proof", "cta_band"],
    subjects: ["hero_shoe", "colourway_detail"],
  },
  {
    id: "bookshop", label: "Bookshop", category: "retail",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "editorial_long", "cta_band"],
    subjects: ["book_stack", "shop_interior"],
  },
  {
    id: "florist", label: "Florist", category: "retail",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "process_timeline", "location_hours", "contact_form"],
    subjects: ["signature_arrangement", "stem_detail"],
  },
  {
    id: "hardware_store", label: "Hardware store", category: "retail",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "faq", "contact_form"],
    subjects: ["tool_hero", "aisle_detail"],
  },
  {
    id: "electronics_shop", label: "Electronics retailer", category: "retail",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "feature_grid", "pricing", "faq", "cta_band"],
    subjects: ["hero_device", "component_detail"],
  },
  {
    id: "cosmetics", label: "Cosmetics / skincare", category: "retail",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "feature_grid", "proof", "pricing", "faq", "cta_band"],
    subjects: ["hero_product", "texture_detail"],
  },
  {
    id: "pet_supplies", label: "Pet supplies", category: "retail",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "faq", "cta_band"],
    subjects: ["product_hero", "packaging"],
  },
  {
    id: "art_gallery", label: "Art gallery", category: "retail",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "editorial_long", "team", "location_hours", "contact_form"],
    subjects: ["featured_work", "space_detail"],
  },
  {
    id: "antiques", label: "Antiques / vintage", category: "retail",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "gallery", "editorial_long", "location_hours", "contact_form"],
    subjects: ["featured_piece", "patina_detail"],
  },
  {
    id: "bike_shop", label: "Bicycle shop", category: "retail",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "product_showcase_3d", "feature_grid", "pricing", "location_hours", "contact_form"],
    subjects: ["hero_bike", "component_detail"],
  },

  /* ---- SUBSCRIPTION DIGITAL ---- */
  {
    id: "streaming_service", label: "Streaming service", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "gallery", "faq", "proof", "cta_band"],
    subjects: ["device_array", "content_tile"],
    note: "Netflix/Hulu shape. Accounts, tiers, and billing portal are the entire product \u2014 a brochure version is worthless.",
  },
  {
    id: "saas_product", label: "SaaS product", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "product_showcase_3d", "pricing", "proof", "logo_wall", "faq", "cta_band"],
    subjects: ["ui_device", "abstract_system"],
  },
  {
    id: "mobile_app", label: "Mobile app", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "gallery", "pricing", "proof", "faq", "cta_band"],
    subjects: ["phone_device", "icon_mark"],
  },
  {
    id: "online_course", label: "Online course / academy", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "pricing", "proof", "team", "faq", "cta_band"],
    subjects: ["course_device", "subject_object"],
  },
  {
    id: "membership_club", label: "Membership club", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "faq", "contact_form"],
    subjects: ["member_object", "space_detail"],
  },
  {
    id: "newsletter_media", label: "Newsletter / media", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "editorial_long", "pricing", "proof", "stat_band", "cta_band"],
    subjects: ["publication_object", "archive_detail"],
  },
  {
    id: "podcast", label: "Podcast", category: "subscription_digital",
    commerce: "subscription", auth: "optional",
    sections: ["hero3d", "feature_grid", "gallery", "proof", "pricing", "cta_band"],
    subjects: ["microphone", "waveform_object"],
  },
  {
    id: "game_studio", label: "Game studio", category: "subscription_digital",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "gallery", "feature_grid", "proof", "cta_band"],
    subjects: ["hero_asset", "world_detail"],
  },
  {
    id: "stock_assets", label: "Digital assets / templates", category: "subscription_digital",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "feature_grid", "proof", "faq", "cta_band"],
    subjects: ["asset_preview", "grid_detail"],
  },
  {
    id: "cloud_hosting", label: "Hosting / infrastructure", category: "subscription_digital",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "stat_band", "logo_wall", "faq", "cta_band"],
    subjects: ["server_object", "network_abstract"],
  },

  /* ---- HEALTH WELLNESS ---- */
  {
    id: "dental_practice", label: "Dental practice", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "proof", "location_hours", "faq", "contact_form"],
    subjects: ["clinical_object", "practice_detail"],
    note: "Health data raises the stakes \u2014 field encryption and audit logging are doing real work here.",
  },
  {
    id: "medical_clinic", label: "Medical clinic", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "location_hours", "faq", "contact_form"],
    subjects: ["clinical_object", "reception_detail"],
  },
  {
    id: "physiotherapy", label: "Physiotherapy", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "team", "proof", "location_hours", "contact_form"],
    subjects: ["equipment_object", "treatment_room"],
  },
  {
    id: "optician", label: "Optician", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "feature_grid", "location_hours", "contact_form"],
    subjects: ["frames_hero", "lens_detail"],
  },
  {
    id: "veterinary", label: "Veterinary clinic", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "location_hours", "proof", "faq", "contact_form"],
    subjects: ["clinical_object", "waiting_area"],
  },
  {
    id: "therapy_counselling", label: "Therapy / counselling", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "editorial_long", "team", "process_timeline", "faq", "contact_form"],
    subjects: ["calm_object", "room_detail"],
    note: "Keep the tone plain and the claims conservative; this is a regulated space in most jurisdictions.",
  },
  {
    id: "pharmacy", label: "Pharmacy", category: "health_wellness",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "feature_grid", "location_hours", "faq", "contact_form"],
    subjects: ["dispensary_object", "storefront"],
  },
  {
    id: "nutritionist", label: "Nutritionist / dietitian", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "proof", "pricing", "contact_form"],
    subjects: ["ingredient_object", "consultation_detail"],
  },
  {
    id: "spa_wellness", label: "Spa / wellness centre", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "proof", "contact_form"],
    subjects: ["treatment_object", "interior_detail"],
  },
  {
    id: "chiropractic", label: "Chiropractic", category: "health_wellness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "process_timeline", "location_hours", "contact_form"],
    subjects: ["equipment_object", "treatment_room"],
  },

  /* ---- FITNESS ---- */
  {
    id: "gym", label: "Gym", category: "fitness",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "gallery", "team", "location_hours", "faq", "cta_band"],
    subjects: ["equipment_hero", "floor_detail"],
  },
  {
    id: "yoga_studio", label: "Yoga / pilates studio", category: "fitness",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "team", "location_hours", "proof", "cta_band"],
    subjects: ["prop_object", "studio_detail"],
  },
  {
    id: "personal_trainer", label: "Personal trainer", category: "fitness",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "proof", "pricing", "process_timeline", "contact_form"],
    subjects: ["equipment_object", "training_detail"],
  },
  {
    id: "martial_arts", label: "Martial arts / boxing", category: "fitness",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "team", "gallery", "location_hours", "cta_band"],
    subjects: ["equipment_hero", "gym_detail"],
  },
  {
    id: "climbing_gym", label: "Climbing gym", category: "fitness",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "faq", "cta_band"],
    subjects: ["hold_object", "wall_detail"],
  },

  /* ---- BEAUTY ---- */
  {
    id: "hair_salon", label: "Hair salon", category: "beauty",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "team", "location_hours", "proof", "contact_form"],
    subjects: ["tool_object", "chair_detail"],
  },
  {
    id: "barbershop", label: "Barbershop", category: "beauty",
    commerce: "booking", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "team", "location_hours", "cta_band"],
    subjects: ["tool_object", "interior_detail"],
  },
  {
    id: "nail_salon", label: "Nail salon", category: "beauty",
    commerce: "booking", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "cta_band"],
    subjects: ["product_object", "station_detail"],
  },
  {
    id: "tattoo_studio", label: "Tattoo studio", category: "beauty",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "team", "process_timeline", "faq", "location_hours", "contact_form"],
    subjects: ["equipment_object", "studio_detail"],
  },
  {
    id: "aesthetics_clinic", label: "Aesthetics clinic", category: "beauty",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "proof", "pricing", "faq", "contact_form"],
    subjects: ["device_object", "treatment_room"],
  },

  /* ---- PROFESSIONAL SERVICES ---- */
  {
    id: "law_firm", label: "Law firm", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "proof", "editorial_long", "faq", "contact_form"],
    subjects: ["archive_object", "office_detail"],
    note: "Client intake is confidential \u2014 the encrypted submissions table matters more here than the visuals.",
  },
  {
    id: "accountancy", label: "Accountancy", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "team", "proof", "faq", "contact_form"],
    subjects: ["document_object", "desk_detail"],
  },
  {
    id: "consultancy", label: "Consultancy", category: "professional_services",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "process_timeline", "proof", "logo_wall", "team", "contact_form"],
    subjects: ["abstract_system", "workshop_detail"],
  },
  {
    id: "insurance_broker", label: "Insurance broker", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "faq", "proof", "contact_form"],
    subjects: ["document_object", "office_detail"],
  },
  {
    id: "financial_advisor", label: "Financial advisor", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "team", "proof", "faq", "contact_form"],
    subjects: ["abstract_growth", "desk_detail"],
  },
  {
    id: "recruitment", label: "Recruitment agency", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "logo_wall", "stat_band", "contact_form"],
    subjects: ["abstract_network", "office_detail"],
  },
  {
    id: "marketing_agency", label: "Marketing agency", category: "professional_services",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "feature_grid", "proof", "logo_wall", "team", "contact_form"],
    subjects: ["abstract_system", "studio_detail"],
  },
  {
    id: "architecture", label: "Architecture practice", category: "professional_services",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "editorial_long", "process_timeline", "team", "contact_form"],
    subjects: ["model_massing", "material_detail"],
    note: "3D is close to mandatory \u2014 a massing model is the natural language of the trade.",
  },
  {
    id: "interior_design", label: "Interior design", category: "professional_services",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "process_timeline", "proof", "team", "contact_form"],
    subjects: ["furniture_object", "material_detail"],
  },
  {
    id: "translation", label: "Translation services", category: "professional_services",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "faq", "contact_form"],
    subjects: ["document_object", "abstract_language"],
  },

  /* ---- HOME TRADES ---- */
  {
    id: "plumber", label: "Plumber", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "proof", "process_timeline", "faq", "contact_form"],
    subjects: ["tool_object", "fitting_detail"],
  },
  {
    id: "electrician", label: "Electrician", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "proof", "faq", "location_hours", "contact_form"],
    subjects: ["tool_object", "component_detail"],
  },
  {
    id: "builder", label: "Builder / general contractor", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "process_timeline", "proof", "team", "contact_form"],
    subjects: ["structure_object", "material_detail"],
  },
  {
    id: "roofing", label: "Roofing", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "process_timeline", "proof", "faq", "contact_form"],
    subjects: ["material_object", "detail_shot"],
  },
  {
    id: "landscaping", label: "Landscaping / gardening", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "feature_grid", "proof", "process_timeline", "contact_form"],
    subjects: ["plant_object", "tool_detail"],
  },
  {
    id: "cleaning_service", label: "Cleaning service", category: "home_trades",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "faq", "cta_band"],
    subjects: ["equipment_object", "interior_detail"],
  },
  {
    id: "removals", label: "Removals / moving", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "process_timeline", "feature_grid", "proof", "faq", "contact_form"],
    subjects: ["crate_object", "van_detail"],
  },
  {
    id: "hvac", label: "HVAC / heating", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "process_timeline", "proof", "faq", "contact_form"],
    subjects: ["unit_object", "component_detail"],
  },
  {
    id: "locksmith", label: "Locksmith", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "location_hours", "proof", "faq", "contact_form"],
    subjects: ["lock_object", "tool_detail"],
  },
  {
    id: "pest_control", label: "Pest control", category: "home_trades",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "feature_grid", "process_timeline", "faq", "proof", "contact_form"],
    subjects: ["equipment_object", "detail_shot"],
  },

  /* ---- AUTOMOTIVE ---- */
  {
    id: "car_dealership", label: "Car dealership", category: "automotive",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "gallery", "feature_grid", "location_hours", "contact_form"],
    subjects: ["hero_vehicle", "interior_detail"],
  },
  {
    id: "auto_repair", label: "Auto repair garage", category: "automotive",
    commerce: "booking", auth: "optional",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "location_hours", "faq", "contact_form"],
    subjects: ["tool_object", "engine_detail"],
  },
  {
    id: "car_wash", label: "Car wash / detailing", category: "automotive",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "gallery", "location_hours", "cta_band"],
    subjects: ["equipment_object", "finish_detail"],
  },
  {
    id: "tyre_shop", label: "Tyre / wheel shop", category: "automotive",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "product_showcase_3d", "pricing", "location_hours", "faq", "contact_form"],
    subjects: ["wheel_hero", "tread_detail"],
  },
  {
    id: "motorcycle_shop", label: "Motorcycle shop", category: "automotive",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "product_showcase_3d", "gallery", "feature_grid", "location_hours", "contact_form"],
    subjects: ["hero_bike", "component_detail"],
  },

  /* ---- PROPERTY HOSPITALITY ---- */
  {
    id: "estate_agent", label: "Estate agent", category: "property_hospitality",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "gallery", "feature_grid", "team", "proof", "location_hours", "contact_form"],
    subjects: ["building_massing", "interior_detail"],
  },
  {
    id: "property_management", label: "Property management", category: "property_hospitality",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "faq", "contact_form"],
    subjects: ["building_object", "key_detail"],
  },
  {
    id: "hotel", label: "Hotel", category: "property_hospitality",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "feature_grid", "location_hours", "proof", "faq", "contact_form"],
    subjects: ["room_object", "facade_detail"],
  },
  {
    id: "bnb_rental", label: "B&B / holiday rental", category: "property_hospitality",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "proof", "faq", "contact_form"],
    subjects: ["interior_object", "exterior_detail"],
  },
  {
    id: "coworking", label: "Coworking space", category: "property_hospitality",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "feature_grid", "location_hours", "cta_band"],
    subjects: ["desk_object", "interior_detail"],
  },
  {
    id: "storage_facility", label: "Self storage", category: "property_hospitality",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "faq", "cta_band"],
    subjects: ["unit_object", "facility_detail"],
  },

  /* ---- EVENTS CREATIVE ---- */
  {
    id: "wedding_venue", label: "Wedding venue", category: "events_creative",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "proof", "location_hours", "faq", "contact_form"],
    subjects: ["venue_object", "detail_shot"],
  },
  {
    id: "event_planner", label: "Event planner", category: "events_creative",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "process_timeline", "proof", "team", "contact_form"],
    subjects: ["event_object", "setup_detail"],
  },
  {
    id: "photographer", label: "Photographer", category: "events_creative",
    commerce: "booking", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "proof", "process_timeline", "contact_form"],
    subjects: ["camera_object", "print_detail"],
    note: "Enable content protection here \u2014 this is the client type that asks for it by name.",
  },
  {
    id: "videographer", label: "Videographer", category: "events_creative",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "process_timeline", "proof", "pricing", "contact_form"],
    subjects: ["camera_object", "rig_detail"],
  },
  {
    id: "music_venue", label: "Music venue", category: "events_creative",
    commerce: "one_time", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "location_hours", "feature_grid", "cta_band"],
    subjects: ["stage_object", "interior_detail"],
  },
  {
    id: "dj_band", label: "DJ / band", category: "events_creative",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "proof", "pricing", "contact_form"],
    subjects: ["equipment_object", "stage_detail"],
  },
  {
    id: "printing_signage", label: "Printing / signage", category: "events_creative",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "gallery", "pricing", "process_timeline", "faq", "contact_form"],
    subjects: ["print_object", "material_detail"],
  },

  /* ---- EDUCATION ---- */
  {
    id: "private_school", label: "Private school", category: "education",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "gallery", "process_timeline", "location_hours", "faq", "contact_form"],
    subjects: ["campus_massing", "detail_shot"],
  },
  {
    id: "nursery_childcare", label: "Nursery / childcare", category: "education",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "team", "gallery", "location_hours", "faq", "contact_form"],
    subjects: ["play_object", "room_detail"],
    note: "Keep imagery generic; do not request or display identifiable children.",
  },
  {
    id: "tutoring", label: "Tutoring", category: "education",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "team", "faq", "contact_form"],
    subjects: ["subject_object", "desk_detail"],
  },
  {
    id: "driving_school", label: "Driving school", category: "education",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "process_timeline", "faq", "contact_form"],
    subjects: ["vehicle_object", "detail_shot"],
  },
  {
    id: "music_school", label: "Music school", category: "education",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "team", "gallery", "location_hours", "contact_form"],
    subjects: ["instrument_object", "studio_detail"],
  },
  {
    id: "language_school", label: "Language school", category: "education",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "proof", "process_timeline", "faq", "contact_form"],
    subjects: ["abstract_language", "classroom_detail"],
  },

  /* ---- OTHER ---- */
  {
    id: "nonprofit", label: "Nonprofit / charity", category: "other",
    commerce: "one_time", auth: "optional",
    sections: ["hero3d", "editorial_long", "stat_band", "proof", "team", "cta_band", "contact_form"],
    subjects: ["cause_object", "field_detail"],
  },
  {
    id: "church_faith", label: "Faith organisation", category: "other",
    commerce: "none", auth: "optional",
    sections: ["hero3d", "editorial_long", "location_hours", "team", "gallery", "contact_form"],
    subjects: ["space_object", "detail_shot"],
  },
  {
    id: "logistics", label: "Logistics / freight", category: "other",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "process_timeline", "stat_band", "logo_wall", "contact_form"],
    subjects: ["container_object", "fleet_detail"],
  },
  {
    id: "manufacturing", label: "Manufacturing", category: "other",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "product_showcase_3d", "process_timeline", "stat_band", "logo_wall", "faq", "contact_form"],
    subjects: ["component_hero", "machine_detail"],
  },
  {
    id: "security_services", label: "Security services", category: "other",
    commerce: "quote", auth: "required",
    sections: ["hero3d", "feature_grid", "proof", "process_timeline", "faq", "contact_form"],
    subjects: ["equipment_object", "facility_detail"],
  },
  {
    id: "travel_agency", label: "Travel agency", category: "other",
    commerce: "booking", auth: "required",
    sections: ["hero3d", "gallery", "pricing", "proof", "faq", "contact_form"],
    subjects: ["destination_object", "detail_shot"],
  },
  {
    id: "laundry_drycleaning", label: "Laundry / dry cleaning", category: "other",
    commerce: "subscription", auth: "required",
    sections: ["hero3d", "feature_grid", "pricing", "location_hours", "faq", "cta_band"],
    subjects: ["garment_object", "machine_detail"],
  },
  {
    id: "funeral_services", label: "Funeral services", category: "other",
    commerce: "quote", auth: "optional",
    sections: ["hero3d", "editorial_long", "feature_grid", "team", "location_hours", "faq", "contact_form"],
    subjects: ["quiet_object", "interior_detail"],
    note: "Restrained tone throughout. No urgency language, no promotional CTAs, no stat bands.",
  },
];

/** Lookup by id. Returns undefined rather than a default — a silent fallback to
 *  a generic preset is how a dentist ends up with a restaurant's layout. */
export const getPreset = (id: string): IndustryPreset | undefined =>
  INDUSTRY_PRESETS.find((p) => p.id === id);

export const presetsByCategory = (category: string): IndustryPreset[] =>
  INDUSTRY_PRESETS.filter((p) => p.category === category);

export const CATEGORIES = [...new Set(INDUSTRY_PRESETS.map((p) => p.category))];

/**
 * Does this preset need the auth and account surface built?
 *
 * Subscription and booking both do, unconditionally — recurring billing without
 * an account has nothing to attach the subscription to, and a booking without an
 * identity cannot be managed by the person who made it.
 */
export const needsAuth = (p: IndustryPreset): boolean =>
  p.auth === 'required' || p.commerce === 'subscription' || p.commerce === 'booking';
