<template>
  <div class="flex flex-col h-full overflow-auto">
    <header class="flex h-16 flex-shrink-0 items-center gap-4 border-b border-gray-800 px-6">
      <router-link to="/products" class="text-gray-500 hover:text-gray-300 transition-colors">← Products</router-link>
      <h1 class="text-lg font-semibold text-white truncate">{{ product?.title || 'Loading…' }}</h1>
    </header>

    <div v-if="loading" class="flex items-center justify-center py-16">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
    </div>

    <div v-else-if="product" class="flex-1 overflow-auto p-6">

      <!-- Marketplace exclusion banner -->
      <div v-if="product.marketplaceExcluded"
           class="mb-5 flex items-start gap-3 rounded-lg border border-orange-700/60 bg-orange-950/40 px-4 py-3">
        <span class="text-orange-400 text-lg leading-none mt-0.5">⊘</span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-orange-200">Excluded from all marketplaces</p>
          <p class="mt-0.5 text-xs text-orange-400">
            This product will not appear in the eBay or Reverb review queue and no listings will be created for it,
            even if its status changes in Shopify. The Shopify listing is unaffected.
          </p>
        </div>
        <button
          @click="setExcluded(false)"
          :disabled="togglingExclusion"
          class="shrink-0 btn-secondary px-3 py-1.5 text-xs text-green-400 border-green-700/50 hover:border-green-500"
        >
          {{ togglingExclusion ? 'Updating…' : '↩ Re-include on marketplaces' }}
        </button>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">

        <!-- Product info -->
        <div class="lg:col-span-2 space-y-6">
          <div class="card">
            <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Product Details</h2>
            <dl class="grid grid-cols-2 gap-4">
              <div><dt class="text-xs text-gray-500">SKU</dt><dd class="mt-1 font-mono text-sm text-gray-200">{{ product.sku }}</dd></div>
              <div><dt class="text-xs text-gray-500">Brand</dt><dd class="mt-1 text-sm text-gray-200">{{ product.brand || '—' }}</dd></div>
              <div><dt class="text-xs text-gray-500">Category</dt><dd class="mt-1 text-sm text-gray-200">{{ product.category || '—' }}</dd></div>
              <div><dt class="text-xs text-gray-500">Condition</dt><dd class="mt-1"><span class="badge-gray">{{ product.condition }}</span></dd></div>
              <div><dt class="text-xs text-gray-500">Price</dt><dd class="mt-1 text-lg font-bold text-white">${{ product.price }}</dd></div>
              <div><dt class="text-xs text-gray-500">Quantity</dt><dd class="mt-1 text-lg font-bold" :class="product.quantity === 0 ? 'text-red-400' : 'text-white'">{{ product.quantity }}</dd></div>
              <div v-if="product.serialNumber"><dt class="text-xs text-gray-500">Serial Number</dt><dd class="mt-1 font-mono text-sm text-gray-200">{{ product.serialNumber }}</dd></div>
              <div v-if="product.shopifyProductId"><dt class="text-xs text-gray-500">Shopify ID</dt><dd class="mt-1 font-mono text-xs text-gray-400">{{ product.shopifyProductId }}</dd></div>
            </dl>
          </div>

          <!-- Shipping dimensions card -->
          <div class="card">
            <h2 class="mb-1 text-sm font-semibold uppercase tracking-wider text-gray-500">Shipping</h2>
            <p class="text-xs text-gray-600 mb-4">Used for calculated shipping on eBay and Reverb. Weight syncs from Shopify automatically. Dimensions come from Shopify metafields — see below for setup instructions.</p>
            <dl class="grid grid-cols-2 gap-4">
              <div>
                <dt class="text-xs text-gray-500">Weight</dt>
                <dd class="mt-1 text-sm" :class="product.weightKg ? 'text-gray-200' : 'text-yellow-500'">
                  <template v-if="product.weightKg">
                    {{ kgToOz(product.weightKg) }} oz
                    <span class="text-gray-500 text-xs ml-1">({{ product.weightKg }} kg)</span>
                  </template>
                  <template v-else>Not set — calculated shipping unavailable</template>
                </dd>
              </div>
              <div>
                <dt class="text-xs text-gray-500">Package dimensions</dt>
                <dd class="mt-1 text-sm" :class="hasDimensions ? 'text-gray-200' : 'text-yellow-500'">
                  <template v-if="hasDimensions">
                    {{ product.dimLengthIn }}" × {{ product.dimWidthIn }}" × {{ product.dimHeightIn }}"
                    <span class="text-gray-500 text-xs">(L × W × H)</span>
                  </template>
                  <template v-else>Not set</template>
                </dd>
              </div>
            </dl>
            <div v-if="!hasDimensions" class="mt-4 rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2.5 text-xs text-gray-400 space-y-1.5">
              <p class="font-medium text-gray-300">How to add dimensions in Shopify</p>
              <ol class="list-decimal list-inside space-y-1 text-gray-500">
                <li>In Shopify admin, go to <strong class="text-gray-400">Settings → Custom data → Products</strong> and add three metafield definitions with these exact keys:
                  <ul class="ml-4 mt-1 space-y-0.5 font-mono text-gray-500">
                    <li><code>custom.dim_length_in</code> — type: Decimal number</li>
                    <li><code>custom.dim_width_in</code> — type: Decimal number</li>
                    <li><code>custom.dim_height_in</code> — type: Decimal number</li>
                  </ul>
                </li>
                <li>Edit each product and fill in the dimensions in inches (longest side as length).</li>
                <li>Save the product — Gearline will pick up the values on the next sync.</li>
              </ol>
            </div>
          </div>

          <div v-if="product.description" class="card">
            <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">Description</h2>
            <p class="text-sm text-gray-300 leading-relaxed">{{ product.description }}</p>
          </div>

          <!-- Video URL -->
          <div class="card">
            <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">Demo Video</h2>
            <div v-if="product.videoUrl && !editingVideo" class="space-y-3">
              <div class="aspect-video w-full overflow-hidden rounded-lg bg-gray-900">
                <iframe
                  :src="youtubeEmbedUrl(product.videoUrl)"
                  class="h-full w-full"
                  frameborder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                ></iframe>
              </div>
              <div class="flex items-center gap-2">
                <a :href="product.videoUrl" target="_blank" class="truncate text-xs text-brand-400 hover:text-brand-300">{{ product.videoUrl }}</a>
                <button @click="editingVideo = true; videoUrlDraft = product.videoUrl" class="ml-auto shrink-0 text-xs text-gray-500 hover:text-gray-300">Edit</button>
                <button @click="saveVideoUrl(null)" class="shrink-0 text-xs text-red-500 hover:text-red-400">Remove</button>
              </div>
            </div>
            <div v-else-if="editingVideo || !product.videoUrl" class="space-y-2">
              <input
                v-model="videoUrlDraft"
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                class="input w-full text-sm"
              />
              <p class="text-xs text-gray-500">Paste a YouTube URL. It will sync automatically to Reverb listings.</p>
              <div class="flex gap-2">
                <button @click="saveVideoUrl(videoUrlDraft)" class="btn-primary px-3 py-1.5 text-xs">Save</button>
                <button v-if="editingVideo" @click="editingVideo = false" class="btn-secondary px-3 py-1.5 text-xs">Cancel</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Listings sidebar -->
        <div class="space-y-4">

          <!-- Exclude from marketplaces card -->
          <div class="card" v-if="!product.marketplaceExcluded">
            <h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">Shopify-only product?</h2>
            <p class="text-xs text-gray-500 mb-3">
              Deposit listings, restoration placeholders, and in-store inventory should never appear
              in the eBay or Reverb review queue. Excluding keeps Shopify untouched.
            </p>
            <button
              @click="setExcluded(true)"
              :disabled="togglingExclusion"
              class="btn-secondary w-full py-2 text-xs text-orange-400 border-orange-700/50 hover:border-orange-500"
            >
              {{ togglingExclusion ? 'Updating…' : '✕ Exclude from all marketplaces' }}
            </button>
          </div>

          <div class="card">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Marketplace Listings</h2>
              <button
                @click="openPublishModal"
                class="btn-primary px-3 py-1.5 text-xs"
                :disabled="availableAccounts.length === 0 || product.marketplaceExcluded"
                :title="product.marketplaceExcluded ? 'Product is excluded from marketplaces' : availableAccounts.length === 0 ? 'No marketplace accounts connected' : 'Publish to a marketplace'"
              >
                + New Listing
              </button>
            </div>

            <div v-if="listingsLoading" class="space-y-2">
              <div v-for="i in 2" :key="i" class="h-16 animate-pulse rounded-lg bg-gray-800"></div>
            </div>

            <div v-else-if="listings.length === 0" class="py-6 text-center text-sm text-gray-500">
              No listings yet
            </div>

            <div v-else class="space-y-2">
              <div v-for="l in listings" :key="l.id" :class="listingCardClass(l)" class="rounded-lg border p-3">

                <!-- Header: marketplace name + status pill -->
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span :class="listingDot(l.listingStatus)"></span>
                    <span class="text-xs font-semibold text-gray-200">{{ marketplaceName(l.marketplaceType) }}</span>
                  </div>
                  <span :class="listingBadge(l.listingStatus)" class="text-xs">{{ listingStatusLabel(l.listingStatus) }}</span>
                </div>

                <!-- Live: show synced price + qty -->
                <div v-if="l.listingStatus === 'ACTIVE' && l.syncedPrice" class="mt-1.5 text-xs text-gray-400">
                  Listed at <span class="text-gray-200 font-medium">${{ l.syncedPrice }}</span> · qty {{ l.syncedQuantity }}
                </div>

                <!-- In-flight -->
                <div v-else-if="l.listingStatus === 'PENDING' || l.listingStatus === 'PUBLISHING'" class="mt-1.5 text-xs text-gray-500">
                  Being published to {{ marketplaceName(l.marketplaceType) }}…
                </div>

                <!-- Not yet published -->
                <div v-else-if="l.listingStatus === 'NEEDS_REVIEW' && !l.lastError" class="mt-1.5 text-xs text-gray-500">
                  Not yet published. Review and click Publish when ready.
                </div>

                <!-- Failed -->
                <div v-if="l.lastError" class="mt-1.5 text-xs text-red-400 break-words" :title="l.lastError">{{ l.lastError }}</div>

                <!-- Taken down -->
                <div v-if="l.listingStatus === 'DELISTED' || l.listingStatus === 'INACTIVE'" class="mt-1.5 text-xs text-gray-500">
                  Removed from {{ marketplaceName(l.marketplaceType) }}. Publish again to relist.
                </div>
                <div v-if="l.listingStatus === 'SOLD'" class="mt-1.5 text-xs text-gray-500">
                  Sold on {{ marketplaceName(l.marketplaceType) }}.
                </div>

                <!-- Actions -->
                <div class="mt-2.5 flex items-center gap-3">
                  <!-- Publish / Republish -->
                  <button
                    v-if="l.listingStatus !== 'ACTIVE' && l.listingStatus !== 'PENDING' && l.listingStatus !== 'PUBLISHING' && l.listingStatus !== 'SOLD'"
                    @click="publishListing(l)"
                    :disabled="publishingId === l.id || hasOverrideErrors(l)"
                    class="text-xs font-medium text-brand-400 hover:text-brand-300 disabled:opacity-40"
                    :title="hasOverrideErrors(l) ? 'Fix field limit violations before publishing' : ''"
                  >
                    {{ publishingId === l.id ? 'Publishing…' : (l.listingStatus === 'DELISTED' || l.listingStatus === 'INACTIVE' ? 'Relist' : 'Publish') }}
                  </button>

                  <!-- In-flight spinner -->
                  <span v-if="l.listingStatus === 'PENDING' || l.listingStatus === 'PUBLISHING'" class="text-xs text-gray-500">
                    Publishing…
                  </span>

                  <!-- Delist (only when live) -->
                  <button
                    v-if="l.listingStatus === 'ACTIVE'"
                    @click="delistListing(l)"
                    :disabled="delistingId === l.id"
                    class="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40"
                  >
                    {{ delistingId === l.id ? 'Removing…' : 'Delist' }}
                  </button>

                  <button
                    @click="toggleOverridesEditor(l.id)"
                    class="text-xs text-gray-500 hover:text-gray-300 ml-auto"
                  >
                    {{ overridesOpen === l.id ? 'Hide overrides ▲' : 'Edit overrides ▼' }}
                  </button>
                </div>

                <!-- Overrides editor (inline expand) -->
                <div v-if="overridesOpen === l.id" class="mt-3 border-t border-gray-800 pt-3 space-y-3">
                  <p class="text-xs text-gray-500">
                    Override specific fields for this channel. Leave blank to use product defaults.
                  </p>

                  <!-- Product title warning if it exceeds the marketplace limit -->
                  <div
                    v-if="productTitleWarning(l.marketplaceType) && !editOverrides[l.id]?.title"
                    class="rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-3 py-2 text-xs text-yellow-300"
                  >
                    ⚠ Product title is <strong>{{ product.title.length }} chars</strong> —
                    over {{ l.marketplaceType }}'s {{ LIMITS[l.marketplaceType]?.title }}-character limit.
                    Enter a title override below.
                  </div>

                  <!-- Generic overrides -->
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label class="text-xs text-gray-500">Price override</label>
                      <input v-model="editOverrides[l.id].price" type="number" step="0.01" class="input w-full mt-1 py-1 text-xs" />
                    </div>
                    <div>
                      <FieldWithCounter
                        label="Title override"
                        v-model="editOverrides[l.id].title"
                        :placeholder="product.title"
                        :limit="LIMITS[l.marketplaceType]?.title"
                        :effective-value="editOverrides[l.id].title || product.title"
                      />
                    </div>
                  </div>

                  <!-- Reverb-specific -->
                  <template v-if="l.marketplaceType === 'REVERB'">
                    <p class="text-xs font-medium text-gray-400">Reverb</p>
                    <div class="grid grid-cols-2 gap-2">
                      <FieldWithCounter
                        label="Model"
                        v-model="editOverrides[l.id].reverb_model"
                        :placeholder="product.category"
                        :limit="LIMITS.REVERB.model"
                      />
                      <div>
                        <label class="text-xs text-gray-500">Year</label>
                        <input v-model="editOverrides[l.id].reverb_year" placeholder="e.g. 1965"
                          class="input w-full mt-1 py-1 text-xs"
                          :class="yearError(editOverrides[l.id].reverb_year) ? 'border-red-500' : ''" />
                        <p v-if="yearError(editOverrides[l.id].reverb_year)" class="mt-1 text-xs text-red-400">{{ yearError(editOverrides[l.id].reverb_year) }}</p>
                      </div>
                      <FieldWithCounter
                        label="Finish"
                        v-model="editOverrides[l.id].reverb_finish"
                        placeholder="e.g. Sunburst"
                        :limit="LIMITS.REVERB.finish"
                      />
                      <div>
                        <label class="text-xs text-gray-500">Shipping profile</label>
                        <select
                          v-model="editOverrides[l.id].reverb_shipping_profile_name"
                          class="input w-full mt-1 py-1 text-xs"
                        >
                          <option value="">
                            {{ reverbProfilesLoading[l.marketplaceAccountId] ? 'Loading…' : '— Select profile —' }}
                          </option>
                          <option
                            v-for="p in reverbProfilesFor(l.marketplaceAccountId)"
                            :key="p.id"
                            :value="String(p.id)"
                          >{{ p.name }}</option>
                        </select>
                      </div>
                    </div>
                  </template>

                  <!-- eBay-specific -->
                  <template v-if="l.marketplaceType === 'EBAY'">
                    <p class="text-xs font-medium text-gray-400">eBay</p>

                    <!-- Account-level defaults summary -->
                    <div class="rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2 text-xs text-gray-400 space-y-1">
                      <p class="font-medium text-gray-300">Account defaults (set on Marketplaces page)</p>
                      <div class="grid grid-cols-3 gap-2 mt-1">
                        <div>
                          <span class="text-gray-600">Location: </span>
                          <span>{{ ebayAccountDefault(l.marketplaceAccountId, 'location') }}</span>
                        </div>
                        <div>
                          <span class="text-gray-600">Fulfillment: </span>
                          <span>{{ ebayAccountDefault(l.marketplaceAccountId, 'fulfillment') }}</span>
                        </div>
                        <div>
                          <span class="text-gray-600">Returns: </span>
                          <span>{{ ebayAccountDefault(l.marketplaceAccountId, 'return') }}</span>
                        </div>
                      </div>
                      <p v-if="!hasEbayDefaults(l.marketplaceAccountId)" class="text-yellow-400 mt-1">
                        ⚠ No account defaults set — go to Marketplaces → eBay → Edit to configure them.
      </p>
                    </div>

                    <!-- Category search -->
                    <div>
                      <label class="text-xs text-gray-500">Category</label>
                      <div class="flex gap-2 mt-1">
                        <input
                          v-model="ebayCategorySearch[l.id]"
                          placeholder="Search e.g. 'electric guitar'"
                          class="input flex-1 py-1 text-xs"
                          @keydown.enter.prevent="searchEbayCategories(l)"
                        />
                        <button
                          @click="searchEbayCategories(l)"
                          :disabled="ebayCategorySearching[l.id]"
                          class="btn-secondary px-3 py-1 text-xs shrink-0"
                        >{{ ebayCategorySearching[l.id] ? '…' : 'Search' }}</button>
                      </div>
                      <!-- Search results -->
                      <div v-if="ebayCategoryResults[l.id]?.length" class="mt-1 rounded-lg border border-gray-700 overflow-hidden">
                        <button
                          v-for="cat in ebayCategoryResults[l.id]"
                          :key="cat.categoryId"
                          class="block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-800 border-b border-gray-800 last:border-0"
                          :class="editOverrides[l.id].ebay_category_id === cat.categoryId ? 'text-brand-400 bg-gray-800' : 'text-gray-300'"
                          @click="selectEbayCategory(l.id, cat)"
                        >
                          {{ cat.categoryName }}
                          <span class="text-gray-600 ml-1">#{{ cat.categoryId }}</span>
                        </button>
                      </div>
                      <div v-else-if="ebayCategoryResults[l.id]?.length === 0" class="mt-1 text-xs text-gray-600 px-1">No results.</div>
                      <!-- Selected value -->
                      <p v-if="editOverrides[l.id].ebay_category_id" class="mt-1 text-xs text-gray-500">
                        Selected: <span class="text-gray-300 font-mono">{{ editOverrides[l.id].ebay_category_id }}</span>
                        <button @click="editOverrides[l.id].ebay_category_id = ''; ebayCategoryResults[l.id] = null" class="ml-2 text-gray-600 hover:text-gray-400">✕</button>
                      </p>
                    </div>
                    <!-- Description override — eBay product.description max 4000 chars -->
                    <div>
                      <div class="flex items-center justify-between mb-1">
                        <label class="text-xs text-gray-500">Description override</label>
                        <CharCounter :value="editOverrides[l.id].description || product.description || ''" :limit="LIMITS.EBAY.description" />
                      </div>
                      <textarea
                        v-model="editOverrides[l.id].description"
                        :placeholder="product.description || 'Override description for eBay (max 4000 chars)'"
                        rows="4"
                        class="input w-full mt-0 py-1 text-xs resize-none"
                        :class="descriptionOverLimit('EBAY', editOverrides[l.id].description) ? 'border-red-500' : ''"
                      ></textarea>
                      <p v-if="descriptionOverLimit('EBAY', editOverrides[l.id].description)" class="mt-1 text-xs text-red-400">
                        Exceeds eBay's {{ LIMITS.EBAY.description }}-character limit. Trim the description or it will be rejected.
                      </p>
                      <p v-else-if="!editOverrides[l.id].description && productDescriptionWarning('EBAY')" class="mt-1 text-xs text-yellow-400">
                        ⚠ Product description is {{ (product.description || '').length }} chars — over eBay's {{ LIMITS.EBAY.description }}-char limit. Enter an override above.
                      </p>
                    </div>
                  </template>

                  <!-- Validation summary -->
                  <div v-if="overrideValidationErrors(l).length > 0" class="rounded-lg bg-red-900/30 border border-red-700/50 px-3 py-2 space-y-1">
                    <p v-for="err in overrideValidationErrors(l)" :key="err" class="text-xs text-red-300">{{ err }}</p>
                  </div>

                  <div class="flex items-center gap-2 pt-1">
                    <button
                      @click="saveOverrides(l)"
                      :disabled="savingOverridesId === l.id || overrideValidationErrors(l).length > 0"
                      class="btn-primary px-3 py-1 text-xs disabled:opacity-50"
                    >
                      {{ savingOverridesId === l.id ? 'Saving…' : 'Save overrides' }}
                    </button>
                    <span v-if="overridesSavedId === l.id" class="text-xs text-green-400">Saved</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Publish modal -->
    <div v-if="showPublishModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="w-full max-w-md rounded-xl bg-gray-900 border border-gray-800 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <h3 class="text-sm font-semibold text-white">Publish to Marketplace</h3>
          <button @click="closePublishModal" class="text-gray-500 hover:text-gray-300">✕</button>
        </div>

        <form @submit.prevent="submitPublish" class="p-5 space-y-4">
          <!-- Marketplace account -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Marketplace account</label>
            <select v-model="publishForm.accountId" required class="input w-full py-2 text-sm">
              <option value="">Select an account…</option>
              <option v-for="a in availableAccounts" :key="a.id" :value="a.id">
                {{ a.marketplaceType }} — {{ a.displayName || a.id }}
              </option>
            </select>
          </div>

          <template v-if="selectedAccountType">
            <!-- Product title warning banner -->
            <div
              v-if="productTitleWarning(selectedAccountType) && !publishForm.title"
              class="rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-3 py-2 text-xs text-yellow-300"
            >
              ⚠ Product title is <strong>{{ product.title.length }} chars</strong> —
              over {{ selectedAccountType }}'s {{ LIMITS[selectedAccountType]?.title }}-character limit.
              Enter a shorter title override below.
            </div>

            <!-- Generic overrides -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Price override</label>
                <input v-model="publishForm.price" type="number" step="0.01" :placeholder="String(product.price)" class="input w-full py-1.5 text-sm" />
              </div>
              <FieldWithCounter
                label="Title override"
                v-model="publishForm.title"
                :placeholder="product.title"
                :limit="LIMITS[selectedAccountType]?.title"
                :effective-value="publishForm.title || product.title"
                size="sm"
              />
            </div>

            <!-- Reverb fields -->
            <template v-if="selectedAccountType === 'REVERB'">
              <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Reverb</p>
              <div class="grid grid-cols-2 gap-3">
                <FieldWithCounter
                  label="Model"
                  v-model="publishForm.reverb_model"
                  :placeholder="product.category || product.title"
                  :limit="LIMITS.REVERB.model"
                  size="sm"
                />
                <div>
                  <label class="block text-xs font-medium text-gray-400 mb-1">Year</label>
                  <input v-model="publishForm.reverb_year" placeholder="e.g. 1965"
                    class="input w-full py-1.5 text-sm"
                    :class="yearError(publishForm.reverb_year) ? 'border-red-500' : ''" />
                  <p v-if="yearError(publishForm.reverb_year)" class="mt-1 text-xs text-red-400">{{ yearError(publishForm.reverb_year) }}</p>
                </div>
                <FieldWithCounter
                  label="Finish"
                  v-model="publishForm.reverb_finish"
                  placeholder="e.g. Sunburst"
                  :limit="LIMITS.REVERB.finish"
                  size="sm"
                />
                <div>
                  <label class="block text-xs font-medium text-gray-400 mb-1">Shipping profile</label>
                  <select
                    v-model="publishForm.reverb_shipping_profile_name"
                    class="input w-full py-1.5 text-sm"
                  >
                    <option value="">
                      {{ reverbProfilesLoading[publishForm.accountId] ? 'Loading…' : '— Select profile —' }}
                    </option>
                    <option
                      v-for="p in reverbProfilesFor(publishForm.accountId)"
                      :key="p.id"
                      :value="String(p.id)"
                    >{{ p.name }}</option>
                  </select>
                </div>
              </div>
            </template>

            <!-- eBay fields -->
            <template v-if="selectedAccountType === 'EBAY'">
              <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">eBay</p>
              <div class="grid grid-cols-2 gap-3">
                <FieldWithCounter
                  label="Merchant location key *"
                  v-model="publishForm.ebay_merchant_location_key"
                  placeholder="Required"
                  :limit="LIMITS.EBAY.merchantLocationKey"
                  size="sm"
                />
                <div>
                  <label class="block text-xs font-medium text-gray-400 mb-1">Category ID</label>
                  <input v-model="publishForm.ebay_category_id" placeholder="eBay leaf category ID" class="input w-full py-1.5 text-sm" />
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-400 mb-1">Fulfillment policy ID</label>
                  <input v-model="publishForm.ebay_fulfillment_policy_id" placeholder="UUID" class="input w-full py-1.5 text-sm" />
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-400 mb-1">Return policy ID</label>
                  <input v-model="publishForm.ebay_return_policy_id" placeholder="UUID" class="input w-full py-1.5 text-sm" />
                </div>
              </div>
              <!-- Description override -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-xs font-medium text-gray-400">Description override</label>
                  <CharCounter :value="publishForm.description || product.description || ''" :limit="LIMITS.EBAY.description" />
                </div>
                <textarea
                  v-model="publishForm.description"
                  :placeholder="product.description || 'Override description for eBay (max 4000 chars)'"
                  rows="4"
                  class="input w-full py-1.5 text-sm resize-none"
                  :class="descriptionOverLimit('EBAY', publishForm.description) ? 'border-red-500' : ''"
                ></textarea>
                <p v-if="!publishForm.description && productDescriptionWarning('EBAY')" class="mt-1 text-xs text-yellow-400">
                  ⚠ Product description is {{ (product.description || '').length }} chars — over eBay's {{ LIMITS.EBAY.description }}-char limit.
                </p>
              </div>
            </template>

            <!-- Publish modal validation errors -->
            <div v-if="publishValidationErrors.length > 0" class="rounded-lg bg-red-900/30 border border-red-700/50 px-3 py-2 space-y-1">
              <p v-for="err in publishValidationErrors" :key="err" class="text-xs text-red-300">{{ err }}</p>
            </div>
          </template>

          <div v-if="publishError" class="text-xs text-red-400">{{ publishError }}</div>

          <div class="flex justify-end gap-3 pt-2">
            <button type="button" @click="closePublishModal" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button
              type="submit"
              :disabled="publishing || publishValidationErrors.length > 0"
              class="btn-primary px-4 py-2 text-sm disabled:opacity-50"
            >
              {{ publishing ? 'Publishing…' : 'Create & Publish' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, defineComponent, h } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/lib/api'

// ── Field limit constants (sourced from official API docs) ────────────────────
// eBay Inventory API: https://developer.ebay.com/api-docs/sell/inventory/types/slr:Product
// eBay Offer:         https://developer.ebay.com/api-docs/sell/inventory/types/slr:EbayOfferDetailsWithAll
// Reverb API:         https://www.reverb.com/api#listings
const LIMITS = {
  REVERB: {
    title: 70,          // Reverb listing title hard limit
    make: 255,          // product.brand → Reverb make field
    model: 255,         // reverb_model extra param
    finish: 255,        // reverb_finish extra param
    description: 15000, // No stated hard limit; 15k is a practical warning threshold
  },
  EBAY: {
    title: 80,               // product.title → eBay Product.title: Max Length 80
    description: 4000,       // product.description → eBay Product.description: Max Length 4000
    brand: 65,               // product.brand → eBay product.brand: Max Length 65
    conditionDescription: 1000, // conditionDescription: Max Length 1000
    merchantLocationKey: 36, // merchantLocationKey: Max Length 36
    sku: 50,                 // sku: Max Length 50
    subtitle: 55,            // subtitle: Max Length 55
  },
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * Inline character counter badge.
 * Props: value (string), limit (number)
 */
const CharCounter = defineComponent({
  props: { value: String, limit: Number },
  setup(props) {
    return () => {
      if (!props.limit) return null
      const len = (props.value || '').length
      const pct = len / props.limit
      const color = len > props.limit
        ? 'text-red-400'
        : pct >= 0.9 ? 'text-yellow-400' : 'text-gray-500'
      return h('span', { class: `text-xs tabular-nums ${color}` }, `${len}/${props.limit}`)
    }
  },
})

/**
 * Text input with live char counter.
 * Props: label, modelValue, placeholder, limit, effectiveValue (for when the actual sent value
 *        is a fallback rather than what's typed), size ('xs'|'sm')
 */
const FieldWithCounter = defineComponent({
  props: {
    label: String,
    modelValue: String,
    placeholder: String,
    limit: Number,
    effectiveValue: String,   // value actually sent to API (may differ from modelValue when blank=fallback)
    size: { type: String, default: 'xs' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => {
      const val = props.modelValue || ''
      const effective = props.effectiveValue || val
      const len = effective.length
      const overLimit = props.limit && len > props.limit
      const nearLimit = props.limit && len >= props.limit * 0.9 && !overLimit
      const inputClass = [
        'input w-full mt-1 py-1',
        props.size === 'sm' ? 'text-sm' : 'text-xs',
        overLimit ? 'border-red-500' : '',
      ].join(' ')

      return h('div', {}, [
        h('div', { class: 'flex items-center justify-between' }, [
          h('label', { class: 'text-xs text-gray-500' }, props.label),
          props.limit
            ? h(CharCounter, { value: effective, limit: props.limit })
            : null,
        ]),
        h('input', {
          type: 'text',
          value: props.modelValue,
          placeholder: props.placeholder,
          class: inputClass,
          onInput: (e) => emit('update:modelValue', e.target.value),
        }),
        overLimit
          ? h('p', { class: 'mt-1 text-xs text-red-400' },
              `Exceeds ${props.limit}-character limit by ${len - props.limit}.`)
          : nearLimit
            ? h('p', { class: 'mt-1 text-xs text-yellow-400' },
                `Approaching ${props.limit}-character limit.`)
            : null,
      ])
    }
  },
})

// ── Page state ────────────────────────────────────────────────────────────────

const route = useRoute()
const product = ref(null)
const listings = ref([])
const accounts = ref([])
const loading = ref(true)
const togglingExclusion = ref(false)
const listingsLoading = ref(true)

// Publish modal state
const showPublishModal = ref(false)
const publishing = ref(false)
const publishError = ref(null)
const publishForm = ref(emptyPublishForm())

// Inline listing actions
const publishingId = ref(null)
const delistingId = ref(null)

// Overrides editor state
const overridesOpen = ref(null)
const editOverrides = ref({})
const savingOverridesId = ref(null)
const overridesSavedId = ref(null)

// Reverb shipping profiles — keyed by accountId, loaded on demand
const reverbShippingProfiles = ref({}) // { [accountId]: [{id, name}, ...] }
const reverbProfilesLoading = ref({})  // { [accountId]: boolean }

// eBay category search — keyed by listing ID
const ebayCategorySearch = ref({})    // { [listingId]: string }
const ebayCategorySearching = ref({}) // { [listingId]: boolean }
const ebayCategoryResults = ref({})   // { [listingId]: [{categoryId, categoryName, level}] | null }

// Video URL editor state
const editingVideo = ref(false)
const videoUrlDraft = ref('')

// ── Shipping unit helpers ─────────────────────────────────────────────────────

/** Convert kg to oz, rounded to 1 decimal place. */
function kgToOz(kg) {
  if (kg == null) return null
  return (parseFloat(kg) * 35.27396).toFixed(1)
}

/** Convert cm to inches, rounded to 2 decimal places. */
function cmToIn(cm) {
  if (cm == null) return null
  return (parseFloat(cm) * 0.393701).toFixed(2)
}

// ── Computed ──────────────────────────────────────────────────────────────────

const hasDimensions = computed(() =>
  product.value?.dimLengthIn != null &&
  product.value?.dimWidthIn  != null &&
  product.value?.dimHeightIn != null
)

const existingAccountIds = computed(() =>
  new Set(listings.value.map(l => l.marketplaceAccountId))
)
const availableAccounts = computed(() =>
  accounts.value.filter(a => a.active && !existingAccountIds.value.has(a.id))
)
const selectedAccountType = computed(() => {
  const a = accounts.value.find(a => a.id === publishForm.value.accountId)
  return a?.marketplaceType ?? null
})

/** Validation errors for the publish modal — blocks the Publish button */
const publishValidationErrors = computed(() => {
  if (!selectedAccountType.value || !product.value) return []
  return validateFields(publishForm.value, selectedAccountType.value, product.value)
})

// Load Reverb shipping profiles as soon as a Reverb account is chosen in the publish modal
watch(() => publishForm.value.accountId, (accountId) => {
  if (selectedAccountType.value === 'REVERB' && accountId) {
    loadReverbShippingProfiles(accountId)
  }
})

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Returns true if product.title (the fallback) would exceed the marketplace title limit,
 * and no override has been entered yet.
 */
function productTitleWarning(marketplaceType) {
  if (!product.value || !LIMITS[marketplaceType]?.title) return false
  return product.value.title.length > LIMITS[marketplaceType].title
}

/**
 * Returns true if product.description (the fallback) would exceed the marketplace description limit.
 */
function productDescriptionWarning(marketplaceType) {
  if (!product.value || !LIMITS[marketplaceType]?.description) return false
  return (product.value.description || '').length > LIMITS[marketplaceType].description
}

/**
 * Returns true if the given description override (or product fallback) exceeds the limit.
 */
function descriptionOverLimit(marketplaceType, overrideValue) {
  const limit = LIMITS[marketplaceType]?.description
  if (!limit) return false
  const val = overrideValue || ''
  return val.length > limit
}

/**
 * Returns an error string if the year value is invalid, otherwise null.
 */
function yearError(val) {
  if (!val || val === '') return null
  const n = parseInt(val, 10)
  if (!/^\d{4}$/.test(String(val).trim())) return 'Must be a 4-digit year (e.g. 1965)'
  if (n < 1900 || n > new Date().getFullYear() + 1)
    return `Year must be between 1900 and ${new Date().getFullYear() + 1}`
  return null
}

/**
 * Validates a form data object against the given marketplace's field limits.
 * Returns an array of human-readable error strings. Empty = no errors.
 */
function validateFields(form, marketplaceType, prod) {
  const errors = []
  const limits = LIMITS[marketplaceType]
  if (!limits) return errors

  // Effective title = override if set, otherwise product title
  const effectiveTitle = (form.title || '').trim() || (prod?.title || '')
  if (limits.title && effectiveTitle.length > limits.title) {
    errors.push(
      `Title is ${effectiveTitle.length} chars — ${marketplaceType} allows ${limits.title}. ` +
      (form.title ? 'Shorten the title override.' : 'Enter a shorter title override.')
    )
  }

  if (marketplaceType === 'REVERB') {
    if (form.reverb_model && form.reverb_model.length > limits.model) {
      errors.push(`Model is ${form.reverb_model.length} chars — limit is ${limits.model}.`)
    }
    if (form.reverb_finish && form.reverb_finish.length > limits.finish) {
      errors.push(`Finish is ${form.reverb_finish.length} chars — limit is ${limits.finish}.`)
    }
    const ye = yearError(form.reverb_year)
    if (ye) errors.push(`Year: ${ye}`)
  }

  if (marketplaceType === 'EBAY') {
    // Description: check override if set, otherwise check product description fallback
    const effectiveDesc = (form.description || '').trim() || (prod?.description || '')
    if (limits.description && effectiveDesc.length > limits.description) {
      errors.push(
        `Description is ${effectiveDesc.length} chars — eBay allows ${limits.description}. ` +
        (form.description ? 'Shorten the description override.' : 'Enter a shorter description override.')
      )
    }
    if (form.ebay_merchant_location_key && form.ebay_merchant_location_key.length > limits.merchantLocationKey) {
      errors.push(`Merchant location key is ${form.ebay_merchant_location_key.length} chars — limit is ${limits.merchantLocationKey}.`)
    }
  }

  return errors
}

/** Returns validation errors for a listing's current override values */
function overrideValidationErrors(listing) {
  if (!editOverrides.value[listing.id] || !product.value) return []
  return validateFields(editOverrides.value[listing.id], listing.marketplaceType, product.value)
}

/** Returns true if the current override state has any blocking errors */
function hasOverrideErrors(listing) {
  return overrideValidationErrors(listing).length > 0
}

// ── Marketplace exclusion ─────────────────────────────────────────────────────

async function setExcluded(excluded) {
  togglingExclusion.value = true
  try {
    const res = await api.patch(`/products/${route.params.id}/marketplace-excluded`, { excluded })
    product.value = res.data
    // If we just excluded, reload listings too — stubs will have been deleted server-side
    if (excluded) {
      const l = await api.get(`/listings/product/${route.params.id}`)
      listings.value = l.data
    }
  } catch (e) {
    alert('Failed to update marketplace exclusion.')
  } finally {
    togglingExclusion.value = false
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function load() {
  try {
    const [p, l, accs] = await Promise.all([
      api.get(`/products/${route.params.id}`),
      api.get(`/listings/product/${route.params.id}`),
      api.get('/marketplace/accounts'),
    ])
    product.value = p.data
    listings.value = l.data
    accounts.value = accs.data
    l.data.forEach(listing => {
      editOverrides.value[listing.id] = flattenOverrides(listing)
    })
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
    listingsLoading.value = false
  }
}

// ── Publish modal ─────────────────────────────────────────────────────────────

function openPublishModal() {
  publishForm.value = emptyPublishForm()
  publishError.value = null
  showPublishModal.value = true
}

function closePublishModal() {
  showPublishModal.value = false
}

async function submitPublish() {
  if (!publishForm.value.accountId) return
  if (publishValidationErrors.value.length > 0) return
  publishing.value = true
  publishError.value = null

  try {
    const overrides = buildOverrides(publishForm.value)
    const createRes = await api.post('/listings', {
      productId: product.value.id,
      marketplaceAccountId: publishForm.value.accountId,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    })
    const listingId = createRes.data.id
    await api.post(`/listings/${listingId}/publish`)

    const l = await api.get(`/listings/product/${route.params.id}`)
    listings.value = l.data
    l.data.forEach(listing => {
      if (!editOverrides.value[listing.id]) {
        editOverrides.value[listing.id] = flattenOverrides(listing)
      }
    })
    closePublishModal()
  } catch (e) {
    publishError.value = e.response?.data?.message
      || e.response?.data?.error
      || 'Failed to create listing'
  } finally {
    publishing.value = false
  }
}

// ── Listing actions ───────────────────────────────────────────────────────────

async function publishListing(listing) {
  if (hasOverrideErrors(listing)) return
  publishingId.value = listing.id
  try {
    await api.post(`/listings/${listing.id}/publish`)
    await refreshListings()
  } catch (e) { console.error(e) }
  finally { publishingId.value = null }
}

async function delistListing(listing) {
  delistingId.value = listing.id
  try {
    await api.post(`/listings/${listing.id}/delist`)
    await refreshListings()
  } catch (e) { console.error(e) }
  finally { delistingId.value = null }
}

// ── Overrides editor ──────────────────────────────────────────────────────────

function toggleOverridesEditor(listingId) {
  overridesOpen.value = overridesOpen.value === listingId ? null : listingId
  // Eagerly load Reverb shipping profiles if opening a Reverb listing
  if (overridesOpen.value) {
    const listing = listings.value.find(l => l.id === listingId)
    if (listing?.marketplaceType === 'REVERB') {
      loadReverbShippingProfiles(listing.marketplaceAccountId)
    }
  }
}

// ── Reverb shipping profiles ──────────────────────────────────────────────────

/**
 * Fetches shipping profiles for a Reverb account and caches them by account ID.
 * No-ops if already loaded or currently loading.
 */
async function loadReverbShippingProfiles(accountId) {
  if (!accountId) return
  if (reverbShippingProfiles.value[accountId] || reverbProfilesLoading.value[accountId]) return
  reverbProfilesLoading.value[accountId] = true
  try {
    const res = await api.get(`/marketplace/accounts/${accountId}/reverb/shipping-profiles`)
    reverbShippingProfiles.value[accountId] = res.data
  } catch (e) {
    console.error('Failed to load Reverb shipping profiles', e)
    reverbShippingProfiles.value[accountId] = [] // empty = fall back to typed input
  } finally {
    reverbProfilesLoading.value[accountId] = false
  }
}

function reverbProfilesFor(accountId) {
  return reverbShippingProfiles.value[accountId] || []
}

// ── eBay category search ──────────────────────────────────────────────────────

/**
 * Returns a human-readable label for an account-level eBay default.
 * type: 'location' | 'fulfillment' | 'return'
 */
function ebayAccountDefault(accountId, type) {
  const account = accounts.value.find(a => a.id === accountId)
  if (!account) return '—'
  if (type === 'location') return account.ebayMerchantLocationKey || '—'
  if (type === 'fulfillment') return account.ebayFulfillmentPolicyId
    ? account.ebayFulfillmentPolicyId.slice(0, 8) + '…'
    : '—'
  if (type === 'return') return account.ebayReturnPolicyId
    ? account.ebayReturnPolicyId.slice(0, 8) + '…'
    : '—'
  return '—'
}

/** True if the eBay account has at least one default configured. */
function hasEbayDefaults(accountId) {
  const account = accounts.value.find(a => a.id === accountId)
  if (!account) return false
  return !!(account.ebayMerchantLocationKey || account.ebayFulfillmentPolicyId || account.ebayReturnPolicyId)
}

/** Hits the category-suggestions endpoint and stores results keyed by listing ID. */
async function searchEbayCategories(listing) {
  const q = (ebayCategorySearch.value[listing.id] || '').trim()
  if (!q) return
  ebayCategorySearching.value[listing.id] = true
  ebayCategoryResults.value[listing.id] = null
  try {
    const res = await api.get(
      `/marketplace/accounts/${listing.marketplaceAccountId}/ebay/category-suggestions`,
      { params: { q } }
    )
    ebayCategoryResults.value[listing.id] = res.data?.slice(0, 8) ?? []
  } catch (e) {
    console.error('eBay category search failed', e)
    ebayCategoryResults.value[listing.id] = []
  } finally {
    ebayCategorySearching.value[listing.id] = false
  }
}

/** Selects a category from the search results and collapses the list. */
function selectEbayCategory(listingId, cat) {
  if (!editOverrides.value[listingId]) return
  editOverrides.value[listingId].ebay_category_id = cat.categoryId
  ebayCategoryResults.value[listingId] = null
  ebayCategorySearch.value[listingId] = cat.categoryName
}

async function saveOverrides(listing) {
  if (overrideValidationErrors(listing).length > 0) return
  savingOverridesId.value = listing.id
  overridesSavedId.value = null
  try {
    const overrides = buildOverrides(editOverrides.value[listing.id])
    await api.patch(`/listings/${listing.id}/overrides`, { overrides })
    overridesSavedId.value = listing.id
    setTimeout(() => { if (overridesSavedId.value === listing.id) overridesSavedId.value = null }, 2000)
  } catch (e) { console.error(e) }
  finally { savingOverridesId.value = null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function refreshListings() {
  const l = await api.get(`/listings/product/${route.params.id}`)
  listings.value = l.data
}

function emptyPublishForm() {
  return {
    accountId: '',
    price: '',
    title: '',
    description: '',
    reverb_model: '',
    reverb_year: '',
    reverb_finish: '',
    reverb_shipping_profile_name: '',
    ebay_merchant_location_key: '',
    ebay_category_id: '',
    ebay_fulfillment_policy_id: '',
    ebay_return_policy_id: '',
  }
}

function buildOverrides(form) {
  const result = {}
  const map = {
    price: 'price',
    title: 'title',
    description: 'description',
    reverb_model: 'reverb_model',
    reverb_year: 'reverb_year',
    reverb_finish: 'reverb_finish',
    reverb_shipping_profile_name: 'reverb_shipping_profile_name',
    ebay_merchant_location_key: 'ebay_merchant_location_key',
    ebay_category_id: 'ebay_category_id',
    ebay_fulfillment_policy_id: 'ebay_fulfillment_policy_id',
    ebay_return_policy_id: 'ebay_return_policy_id',
  }
  for (const [formKey, overrideKey] of Object.entries(map)) {
    const val = form[formKey]
    if (val !== '' && val != null) result[overrideKey] = val
  }
  return result
}

function flattenOverrides(listing) {
  const o = listing.listingOverrides || {}
  return {
    price: o.price ?? '',
    title: o.title ?? '',
    description: o.description ?? '',
    reverb_model: o.reverb_model ?? '',
    reverb_year: o.reverb_year ?? '',
    reverb_finish: o.reverb_finish ?? '',
    reverb_shipping_profile_name: o.reverb_shipping_profile_name ?? '',
    ebay_merchant_location_key: o.ebay_merchant_location_key ?? '',
    ebay_category_id: o.ebay_category_id ?? '',
    ebay_fulfillment_policy_id: o.ebay_fulfillment_policy_id ?? '',
    ebay_return_policy_id: o.ebay_return_policy_id ?? '',
  }
}

function listingStatusLabel(s) {
  return {
    ACTIVE:       'Live',
    FAILED:       'Failed',
    PENDING:      'Queued',
    PUBLISHING:   'Publishing',
    NEEDS_REVIEW: 'Not published',
    DELISTED:     'Delisted',
    INACTIVE:     'Inactive',
    SOLD:         'Sold',
  }[s] || s
}

function listingBadge(s) {
  return {
    ACTIVE:       'badge-green',
    FAILED:       'badge-red',
    PENDING:      'badge-yellow',
    PUBLISHING:   'badge-yellow',
    NEEDS_REVIEW: 'badge-gray',
    DELISTED:     'badge-gray',
    INACTIVE:     'badge-gray',
    SOLD:         'badge-blue',
  }[s] || 'badge-gray'
}

function listingDot(s) {
  const base = 'inline-block w-2 h-2 rounded-full flex-shrink-0'
  const color = {
    ACTIVE:       'bg-green-400',
    FAILED:       'bg-red-400',
    PENDING:      'bg-yellow-400',
    PUBLISHING:   'bg-yellow-400',
    NEEDS_REVIEW: 'bg-gray-600',
    DELISTED:     'bg-gray-600',
    INACTIVE:     'bg-gray-600',
    SOLD:         'bg-blue-400',
  }[s] || 'bg-gray-600'
  return `${base} ${color}`
}

function listingCardClass(l) {
  return {
    ACTIVE:       'border-green-800/60 bg-green-950/20',
    FAILED:       'border-red-800/60 bg-red-950/20',
    PENDING:      'border-yellow-800/40',
    PUBLISHING:   'border-yellow-800/40',
    NEEDS_REVIEW: 'border-gray-800',
    DELISTED:     'border-gray-800 opacity-75',
    INACTIVE:     'border-gray-800 opacity-75',
    SOLD:         'border-gray-800 opacity-75',
  }[l.listingStatus] || 'border-gray-800'
}

function marketplaceName(type) {
  return { REVERB: 'Reverb', EBAY: 'eBay', SHOPIFY: 'Shopify' }[type] || type
}

// ── Video URL helpers ─────────────────────────────────────────────────────────

function youtubeEmbedUrl(url) {
  if (!url) return null
  // Handle youtu.be short links
  const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]+)/)
  if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`
  // Handle standard watch?v= links and embed links
  const idMatch = url.match(/[?&]v=([A-Za-z0-9_-]+)/) || url.match(/\/embed\/([A-Za-z0-9_-]+)/)
  if (idMatch) return `https://www.youtube.com/embed/${idMatch[1]}`
  return null
}

async function saveVideoUrl(url) {
  try {
    const res = await api.put(`/products/${product.value.id}`, { videoUrl: url || '' })
    product.value = res.data
    editingVideo.value = false
    videoUrlDraft.value = ''
  } catch (e) {
    alert('Failed to save video URL')
  }
}

onMounted(load)
</script>
