import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  BulkAvailabilityDto,
  CreateCategoryDto,
  CreateItemDto,
  SetHoursDto,
  TemporaryClosureDto,
  UpdateCategoryDto,
  UpdateItemDto,
} from './dto/catalog.dto';

/**
 * Catalog management for the shop dashboard (D-11, D-12, D-13).
 *
 * Routes are nested under a listing because FR-SHOP-13 gives a shop a
 * separate catalog per college — the listing, not the shop, is what owns a
 * menu.
 */
@ApiTags('catalog')
@Controller('shops/:listingId/catalog')
@Roles('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'The full catalog and hours for this listing' })
  list(@CurrentUser() user: AuthenticatedUser, @Param('listingId') listingId: string) {
    return this.catalog.listCatalog(user, listingId);
  }

  // --- Categories (FR-CAT-01) --------------------------------------------

  @Post('categories')
  @ApiOperation({ summary: 'Create a category' })
  createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.catalog.createCategory(user, listingId, dto);
  }

  @Patch('categories/:categoryId')
  @ApiOperation({ summary: 'Rename or reorder a category' })
  updateCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(user, listingId, categoryId, dto);
  }

  @Delete('categories/:categoryId')
  @ApiOperation({ summary: 'Delete a category, keeping its items' })
  deleteCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.catalog.deleteCategory(user, listingId, categoryId);
  }

  // --- Items (FR-CAT-02, FR-CAT-03) --------------------------------------

  @Post('items')
  @ApiOperation({ summary: 'Add a catalog item' })
  createItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.catalog.createItem(user, listingId, dto);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Edit a catalog item' })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.catalog.updateItem(user, listingId, itemId, dto);
  }

  /** FR-CAT-03: the dashboard's bulk availability toggle. */
  @Post('items/availability')
  @ApiOperation({ summary: 'Mark items available or unavailable in bulk' })
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: BulkAvailabilityDto,
  ) {
    return this.catalog.setAvailability(user, listingId, dto);
  }

  @Delete('items/:itemId')
  @ApiOperation({ summary: 'Remove an item from the menu, keeping order history intact' })
  deleteItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.catalog.deleteItem(user, listingId, itemId);
  }

  // --- Hours and closure (FR-CAT-04) -------------------------------------

  @Put('hours')
  @ApiOperation({ summary: 'Replace the weekly opening hours' })
  setHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: SetHoursDto,
  ) {
    return this.catalog.setHours(user, listingId, dto);
  }

  @Post('closure')
  @ApiOperation({ summary: 'Close temporarily until a stated time' })
  setClosure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
    @Body() dto: TemporaryClosureDto,
  ) {
    return this.catalog.setTemporaryClosure(user, listingId, dto);
  }

  @Delete('closure')
  @ApiOperation({ summary: 'Reopen now, returning to normal hours' })
  clearClosure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listingId') listingId: string,
  ) {
    return this.catalog.clearTemporaryClosure(user, listingId);
  }
}
