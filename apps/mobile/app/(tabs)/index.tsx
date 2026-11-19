import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { formatMinor } from '@hoppo/shared';
import type { BrowseShop } from '@hoppo/api-client';
import { Banner, Card, Chip, Empty, Field, Loading } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { TAP, colour, radius, space, text } from '@/lib/theme';

type Sort = 'distance' | 'rating' | 'prepTime';

/**
 * S-10 and S-11: the shop list and search.
 *
 * FR-SVER-01 lets an unverified student browse, so this screen is reachable
 * before approval — with a banner saying what is still locked, rather than
 * silently failing at checkout.
 *
 * FR-CAT-05 shows a closed shop as closed rather than hiding it. A student
 * who knows the chai place opens at eight wants to see it listed at seven,
 * greyed, with the time it opens.
 */
export default function ShopsScreen() {
  const { api, isVerified, user } = useApi();
  const router = useRouter();

  const [shops, setShops] = useState<BrowseShop[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('distance');
  const [openOnly, setOpenOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.browse.shops({
        sort,
        openNow: openOnly || undefined,
        q: query.trim() || undefined,
      });
      setShops(result.items);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api, sort, openOnly, query]);

  useEffect(() => {
    void load();
  }, [load]);

  if (shops === null && !error) return <Loading label="Finding shops near you…" />;

  return (
    <ScrollView
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {/* FR-SVER-01: say what is locked, here, rather than at checkout. */}
      {!isVerified && (
        <Pressable onPress={() => router.push('/(verify)/status')}>
          <Banner tone="waiting">
            You can browse, but ordering unlocks once your campus administrator approves your
            ID. Tap to check.
          </Banner>
        </Pressable>
      )}

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Field
        label="Search"
        hint="Shop or item name"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        returnKeyType="search"
        placeholder="chai, thali, xerox…"
      />

      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg, flexWrap: 'wrap' }}>
        {(
          [
            ['distance', 'Nearest'],
            ['prepTime', 'Fastest'],
            ['rating', 'Best rated'],
          ] as [Sort, string][]
        ).map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setSort(value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: sort === value }}
            style={{
              minHeight: 40,
              justifyContent: 'center',
              paddingHorizontal: space.md,
              borderRadius: radius.pill,
              backgroundColor: sort === value ? colour.accent : colour.surface,
              borderWidth: 1,
              borderColor: sort === value ? colour.accent : colour.line,
            }}
          >
            <Text
              style={{
                fontWeight: '700',
                fontSize: text.small,
                color: sort === value ? '#fff' : colour.inkSoft,
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}

        <Pressable
          onPress={() => setOpenOnly((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: openOnly }}
          style={{
            minHeight: 40,
            justifyContent: 'center',
            paddingHorizontal: space.md,
            borderRadius: radius.pill,
            backgroundColor: openOnly ? colour.accent : colour.surface,
            borderWidth: 1,
            borderColor: openOnly ? colour.accent : colour.line,
          }}
        >
          <Text
            style={{
              fontWeight: '700',
              fontSize: text.small,
              color: openOnly ? '#fff' : colour.inkSoft,
            }}
          >
            Open now
          </Text>
        </Pressable>
      </View>

      {shops?.length === 0 ? (
        <Empty
          title={query ? 'Nothing matched' : 'No shops yet'}
          body={
            query
              ? 'Try a shorter search, or clear it to see everything.'
              : `No shops have been approved at ${user?.college?.name ?? 'your college'} yet.`
          }
        />
      ) : (
        shops?.map((shop) => (
          <Pressable
            key={shop.listingId}
            onPress={() => router.push(`/shop/${shop.listingId}`)}
            accessibilityRole="button"
            accessibilityLabel={`${shop.shop.name}, ${shop.distanceLabel} away, ${
              shop.isOpen ? 'open' : 'closed'
            }`}
            style={{ opacity: shop.isOpen ? 1 : 0.65 }}
          >
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: text.body + 3, fontWeight: '700', color: colour.ink }}>
                    {shop.shop.name}
                  </Text>
                  <Text style={{ fontSize: text.small, color: colour.inkFaint, marginTop: 2 }}>
                    {shop.shop.category.toLowerCase()} · {shop.distanceLabel}
                    {shop.medianPrepMinutes ? ` · about ${shop.medianPrepMinutes} min` : ''}
                  </Text>

                  <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
                    {shop.isOpen ? (
                      <Chip tone="good">Open</Chip>
                    ) : shop.closedReason === 'TEMPORARILY_CLOSED' ? (
                      <Chip tone="danger">Closed{shop.closureNote ? ` — ${shop.closureNote}` : ''}</Chip>
                    ) : shop.opensInMinutes && shop.opensInMinutes < 180 ? (
                      <Chip tone="waiting">Opens in {shop.opensInMinutes} min</Chip>
                    ) : (
                      <Chip>Closed</Chip>
                    )}

                    {/* FR-TRST-06: aggregates only, and only once there are
                        enough ratings that one cannot be identified. */}
                    {shop.averageRating !== null ? (
                      <Chip tone="plain">
                        {shop.averageRating.toFixed(1)} ★ ({shop.ratingCount})
                      </Chip>
                    ) : null}
                  </View>
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
