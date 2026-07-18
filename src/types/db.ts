export type AuctionStatus = "draft" | "live" | "ended" | "sold" | "passed";
export type VehicleGrade = "A" | "B" | "C" | "D" | "E";

export interface Dealer {
  id: string; business_name: string; dealer_license_no: string;
  region: string; is_verified: boolean; initials: string;
}
export interface Vehicle {
  id: string; make: string; model: string; year: number; variant: string | null;
  odometer_km: number; rego: string | null; vin: string | null; grade: VehicleGrade;
  color: string | null; mechanical_notes: string | null; appraisal_notes: string | null;
  photo_urls: string[];
}
export interface Auction {
  id: string; vehicle_id: string; seller_dealer_id: string;
  start_time: string | null; end_time: string; starting_price: number; reserve_price: number;
  buy_now_price: number | null; bid_increment: number; anti_snipe_seconds: number;
  status: AuctionStatus; current_bid: number | null; current_winner_dealer_id: string | null;
}
export interface Bid {
  id: string; auction_id: string; bidder_dealer_id: string;
  amount: number; max_amount: number | null; is_auto: boolean; created_at: string;
}
export interface Settlement {
  id: string; auction_id: string; sale_price: number;
  seller_fee: number; buyer_fee: number; status: string;
}
export type NotificationType = "outbid" | "won" | "sold" | "withdrawn" | "rate";
export interface Notification {
  id: string; recipient_dealer_id: string; type: NotificationType;
  auction_id: string; created_at: string; read_at: string | null;
}
export interface Rating {
  id: string; auction_id: string; rater_dealer_id: string; ratee_dealer_id: string;
  direction: "seller" | "buyer"; score: number; comment: string | null; created_at: string;
}
export interface DealerReputation {
  dealer_id: string;
  seller_avg: number | null; seller_count: number;
  buyer_avg: number | null; buyer_count: number;
}
export interface DealerReview {
  direction: "seller" | "buyer"; score: number; comment: string | null; created_at: string;
}
export interface RatingState {
  eligible: boolean; window_open: boolean; already_rated: boolean;
  counterpart_submitted: boolean; revealed: boolean;
  my_score: number | null; my_comment: string | null;
  counterpart_score: number | null; counterpart_comment: string | null;
}
